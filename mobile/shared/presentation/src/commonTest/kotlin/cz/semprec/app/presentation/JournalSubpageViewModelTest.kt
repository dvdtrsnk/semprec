package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SUBPAGE = "## Clothes\n\n- [x] Jacket\n- [ ] Boots\n\n[Deeper](semprec://page/jv2)"

@OptIn(ExperimentalCoroutinesApi::class)
class JournalSubpageViewModelTest : MainDispatcherTest() {
    private val repository = FakeJournalRepository().apply { onPage = { content(PageDocument(SUBPAGE, "\"v1\"")) } }

    private fun viewModel() = JournalViewModelFactory(repository).journalSubpageViewModel("jv1")

    private fun TestScope.loaded(): JournalSubpageViewModel = viewModel().also { runCurrent() }

    @Test fun `starts loading and shows the blocks of the subpage`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(JournalSubpageState(), vm.state.value)
        runCurrent()
        val state = vm.state.value
        assertEquals(JournalPhase.CONTENT, state.phase)
        assertEquals(
            listOf(JournalBlockKind.H2, JournalBlockKind.TODO, JournalBlockKind.TODO, JournalBlockKind.PAGE),
            state.blocks.map { it.kind },
        )
        assertEquals(listOf(false, true, false, false), state.blocks.map { it.done })
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        var failing = true
        repository.onPage = {
            if (failing) journalFailure(FailureKind.NOT_FOUND) else content(PageDocument(SUBPAGE, "\"v1\""))
        }
        val vm = loaded()
        assertEquals(JournalSubpageState(JournalPhase.ERROR, FailureKind.NOT_FOUND), vm.state.value)
        failing = false
        vm.onAction(JournalSubpageAction.Retry)
        assertEquals(JournalPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        repository.onPage = { error("boom") }
        val vm = loaded()
        assertEquals(JournalSubpageState(JournalPhase.ERROR), vm.state.value)
        vm.close()
    }

    @Test fun `editing writes through the item of the subpage`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalSubpageAction.SetText(0, "Wear"))
        assertTrue(vm.state.value.saving)
        runCurrent()
        assertEquals("jv1", repository.replaced.single().first)
        assertEquals(SUBPAGE.replace("## Clothes", "## Wear"), repository.replaced.single().second)
        assertEquals("Wear", vm.state.value.blocks.first().runs.single().text)
        assertFalse(vm.state.value.saving)
        assertEquals(emptyList(), repository.ensureCalls)
        vm.close()
    }

    @Test fun `toggling and adding go through the same write`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalSubpageAction.ToggleDone(2))
        runCurrent()
        assertTrue(repository.replaced.last().second.contains("- [x] Boots"))
        vm.onAction(JournalSubpageAction.AddBlock(JournalBlockKind.QUOTE, "Remember"))
        runCurrent()
        assertTrue(repository.replaced.last().second.endsWith("> Remember"))
        assertEquals(2, repository.replaced.size)
        vm.close()
    }

    @Test fun `changes that cannot apply are ignored without a request`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalSubpageAction.ToggleDone(0))
        vm.onAction(JournalSubpageAction.ToggleDone(9))
        vm.onAction(JournalSubpageAction.SetText(3, "x"))
        vm.onAction(JournalSubpageAction.SetText(9, "x"))
        vm.onAction(JournalSubpageAction.SetText(0, "Clothes"))
        vm.onAction(JournalSubpageAction.AddBlock(JournalBlockKind.TEXT, " "))
        vm.onAction(JournalSubpageAction.AddBlock(JournalBlockKind.PAGE, "x"))
        runCurrent()
        assertTrue(repository.replaced.isEmpty())
        vm.close()
    }

    @Test fun `a change before the page is loaded is ignored`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onAction(JournalSubpageAction.AddBlock(JournalBlockKind.TEXT, "early"))
        runCurrent()
        assertTrue(repository.replaced.isEmpty())
        vm.close()
    }

    @Test fun `stale edits and conflicts keep the page and say so`() = runTest(dispatcher) {
        repository.onReplace = { _, _, _ -> content(PageWrite.Conflict) }
        val vm = loaded()
        vm.onAction(JournalSubpageAction.ToggleDone(2))
        runCurrent()
        assertEquals(JournalEditProblem.STALE, vm.state.value.editProblem)
        assertFalse(vm.state.value.blocks[2].done)
        vm.onAction(JournalSubpageAction.DismissProblem)
        assertNull(vm.state.value.editProblem)
        repository.onPage = { content(PageDocument("Other", "\"v5\"")) }
        vm.onAction(JournalSubpageAction.SetText(0, "Mine"))
        runCurrent()
        assertEquals(JournalEditProblem.STALE, vm.state.value.editProblem)
        vm.close()
    }

    @Test fun `failed writes are problems`() = runTest(dispatcher) {
        repository.onReplace = { _, _, _ -> journalFailure(FailureKind.UNAVAILABLE) }
        val vm = loaded()
        vm.onAction(JournalSubpageAction.ToggleDone(2))
        runCurrent()
        assertEquals(JournalEditProblem.FAILED, vm.state.value.editProblem)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.editFailure)
        repository.onReplace = { _, _, _ -> error("boom") }
        vm.onAction(JournalSubpageAction.ToggleDone(2))
        runCurrent()
        assertEquals(JournalEditProblem.FAILED, vm.state.value.editProblem)
        assertNull(vm.state.value.editFailure)
        vm.close()
    }

    @Test fun `a second change while writing is ignored`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onReplace = { _, _, _ -> repository.late(gate, content(PageWrite.Saved("\"v2\""))) }
        val vm = loaded()
        vm.onAction(JournalSubpageAction.ToggleDone(2))
        runCurrent()
        vm.onAction(JournalSubpageAction.ToggleDone(1))
        runCurrent()
        assertEquals(1, repository.replaced.size)
        gate.complete(Unit)
        runCurrent()
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `opening a nested subpage is an effect delivered once`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalSubpageAction.OpenPage("jv2", "Deeper"))
        val received = mutableListOf<JournalSubpageEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(listOf<JournalSubpageEffect>(JournalSubpageEffect.OpenPage("jv2", "Deeper")), received)
        vm.close()
    }

    @Test fun `a newer load cancels the older one and a late answer is dropped`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        var calls = 0
        repository.onPage = {
            calls += 1
            if (calls == 1) {
                repository.late(gate, content(PageDocument("OLD", "\"v1\"")))
            } else {
                content(PageDocument("NEW", "\"v2\""))
            }
        }
        val vm = viewModel()
        runCurrent()
        vm.onAction(JournalSubpageAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals("NEW", vm.state.value.blocks.single().runs.single().text)
        vm.close()
    }

    @Test fun `closing ends in flight work and ignores actions`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPage = { repository.late(gate, content(PageDocument(SUBPAGE, "\"v1\""))) }
        val vm = viewModel()
        runCurrent()
        vm.close()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalPhase.LOADING, vm.state.value.phase)
        vm.onAction(JournalSubpageAction.Retry)
        assertTrue(vm.isClosed)
    }

    @Test fun `clearing the owning store ends it like close does`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
    }
}
