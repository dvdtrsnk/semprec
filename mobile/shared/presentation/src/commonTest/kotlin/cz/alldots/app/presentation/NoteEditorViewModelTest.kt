package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.JournalPeriodType
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

internal const val NOTE_PAGE = "# Plan\n\nFirst idea\n\n- one\n- two"

/** A note editor over [pages] and [journal], with the page [NOTE_PAGE] as `p1`, a pause of 700 ms and a fixed clock. */
@OptIn(ExperimentalCoroutinesApi::class)
abstract class NoteEditorTest : MainDispatcherTest() {
    protected val pages = FakeNotePages().apply { put("p1", NOTE_PAGE) }
    protected val journal = FakeJournalRepository()

    protected fun viewModel(source: NoteEditorSource = NoteEditorSource.Page("p1", titleEditable = true)) =
        NoteEditorViewModel(source, pages, journal, NoteEditorSettings(saveDelayMillis = 700, now = { "NOW" }))

    protected fun TestScope.loaded(source: NoteEditorSource = NoteEditorSource.Page("p1", titleEditable = true)) =
        viewModel(source).also { runCurrent() }

    protected fun TestScope.effects(vm: NoteEditorViewModel): MutableList<NoteEditorEffect> {
        val received = mutableListOf<NoteEditorEffect>()
        backgroundScope.launch { vm.effects.collect { received += it } }
        runCurrent()
        return received
    }

    protected fun NoteEditorViewModel.block(index: Int) = state.value.blocks[index]

    protected fun NoteEditorViewModel.texts() =
        state.value.blocks.map { block -> block.runs.joinToString("") { it.text } }

    protected fun TestScope.typed(vm: NoteEditorViewModel, index: Int, text: String) {
        vm.onAction(NoteEditorAction.SetRuns(vm.block(index).id, listOf(NoteEditorRun(text))))
        settle()
    }

    /** Lets the pause pass and every write finish. */
    protected fun TestScope.settle() {
        advanceTimeBy(701)
        runCurrent()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class NoteEditorViewModelTest : NoteEditorTest() {

    @Test fun `a page shows its title and blocks with drawn markers and reading writes nothing`() =
        runTest(dispatcher) {
            val vm = viewModel()
            assertEquals(NoteEditorPhase.LOADING, vm.state.value.phase)
            runCurrent()
            val state = vm.state.value
            assertEquals(NoteEditorPhase.CONTENT, state.phase)
            assertEquals("Title of p1", state.title)
            assertEquals("2026-11-01T10:00:00Z", state.lastEditedAt)
            assertEquals(
                listOf(
                    NoteEditorBlockType.H1,
                    NoteEditorBlockType.TEXT,
                    NoteEditorBlockType.BULLET,
                    NoteEditorBlockType.BULLET,
                ),
                state.blocks.map { it.type },
            )
            assertEquals(
                listOf(null, null, NoteEditorMarker.Bullet(0), NoteEditorMarker.Bullet(0)),
                state.blocks.map { it.marker },
            )
            assertEquals(5, state.wordCount)
            advanceTimeBy(5_000)
            assertEquals(listOf("info p1", "read p1"), pages.calls)
            vm.close()
        }

    @Test fun `a failed read is an error and retry reads again`() = runTest(dispatcher) {
        pages.failing = "info"
        val vm = loaded()
        assertEquals(NoteEditorPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        pages.failing = null
        vm.onAction(NoteEditorAction.Retry)
        runCurrent()
        assertEquals(NoteEditorPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `typing is written once after the pause against the version it read`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("First"))))
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("First draft"))))
        assertTrue(vm.state.value.saving)
        advanceTimeBy(500)
        runCurrent()
        assertFalse(pages.calls.any { it.startsWith("replace") })
        advanceTimeBy(201)
        runCurrent()
        assertEquals(1, pages.calls.count { it.startsWith("replace") })
        assertEquals(NOTE_PAGE.replace("First idea", "First draft"), pages.markdown["p1"])
        assertFalse(vm.state.value.saving)
        assertEquals("NOW", vm.state.value.lastEditedAt)
        typed(vm, 1, "Second draft")
        assertEquals(NOTE_PAGE.replace("First idea", "Second draft"), pages.markdown["p1"])
        vm.close()
    }

    @Test fun `typing while a write is under way keeps the version that write made`() = runTest(dispatcher) {
        val vm = loaded()
        val gate = CompletableDeferred<Unit>()
        pages.replaceGate = gate
        typed(vm, 1, "Sent")
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("Sent and more"))))
        runCurrent()
        pages.replaceGate = null
        gate.complete(Unit)
        settle()
        assertNull(vm.state.value.problem)
        assertEquals(NOTE_PAGE.replace("First idea", "Sent and more"), pages.markdown["p1"])
        vm.close()
    }

    @Test fun `a page changed elsewhere is read again and nothing is written over it`() = runTest(dispatcher) {
        val vm = loaded()
        pages.put("p1", "Written on the phone")
        typed(vm, 1, "Mine")
        assertEquals("Written on the phone", pages.markdown["p1"])
        assertEquals(listOf("Written on the phone"), vm.texts())
        assertEquals(NoteEditorProblem.RELOADED, vm.state.value.problem)
        assertNull(vm.state.value.caret)
        vm.onAction(NoteEditorAction.DismissProblem)
        assertNull(vm.state.value.problem)
        vm.close()
    }

    @Test fun `a page shown again reads what changed in it without loading`() = runTest(dispatcher) {
        val vm = loaded()
        pages.put("p1", "Renamed elsewhere")
        vm.onAction(NoteEditorAction.Refresh)
        assertEquals(NoteEditorPhase.CONTENT, vm.state.value.phase)
        runCurrent()
        assertEquals(listOf("Renamed elsewhere"), vm.texts())
        assertNull(vm.state.value.problem)
        vm.close()
    }

    @Test fun `a page waiting to write its change is not read again`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("Mine"))))
        pages.put("p1", "Elsewhere")
        vm.onAction(NoteEditorAction.Refresh)
        runCurrent()
        assertEquals("Mine", vm.texts()[1])
        vm.close()
    }

    @Test fun `a failed write is reported and the next change writes it again`() = runTest(dispatcher) {
        val vm = loaded()
        pages.failing = "replace"
        typed(vm, 1, "Lost?")
        assertEquals(NoteEditorProblem.FAILED, vm.state.value.problem)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.problemFailure)
        assertEquals(NOTE_PAGE, pages.markdown["p1"])
        pages.failing = null
        typed(vm, 1, "Kept")
        assertEquals(NOTE_PAGE.replace("First idea", "Kept"), pages.markdown["p1"])
        vm.close()
    }

    @Test fun `flush writes a waiting change at once`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("Now"))))
        vm.onAction(NoteEditorAction.Flush)
        runCurrent()
        assertEquals(NOTE_PAGE.replace("First idea", "Now"), pages.markdown["p1"])
        vm.close()
    }

    @Test fun `a change still waiting for its pause is written when the editor closes`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(NoteEditorAction.Delete(listOf(vm.block(1).id)))
        advanceTimeBy(100)
        vm.close()
        runCurrent()
        assertEquals("# Plan\n\n- one\n- two", pages.markdown["p1"])
    }

    @Test fun `a write still on its way when the editor closes reaches the page`() = runTest(dispatcher) {
        val vm = loaded()
        val hold = CompletableDeferred<Unit>()
        pages.replaceHold = hold
        vm.onAction(NoteEditorAction.SetType(listOf(vm.block(2).id), NoteEditorBlockType.TODO))
        vm.onAction(NoteEditorAction.ToggleDone(vm.block(2).id))
        vm.onAction(NoteEditorAction.Flush)
        runCurrent()
        vm.close()
        hold.complete(Unit)
        runCurrent()
        assertEquals("# Plan\n\nFirst idea\n\n- [x] one\n- two", pages.markdown["p1"])
        assertEquals(1, pages.calls.count { it.startsWith("replace") })
    }

    @Test fun `a read again that answers after a newer write is not shown`() = runTest(dispatcher) {
        val vm = loaded()
        val gate = CompletableDeferred<Unit>()
        pages.readGate = gate
        vm.onAction(NoteEditorAction.Refresh)
        runCurrent()
        pages.readGate = null
        typed(vm, 1, "Mine")
        assertEquals(NOTE_PAGE.replace("First idea", "Mine"), pages.markdown["p1"])
        gate.complete(Unit)
        runCurrent()
        assertEquals("Mine", vm.texts()[1])
        typed(vm, 1, "Mine again")
        assertNull(vm.state.value.problem)
        assertEquals(NOTE_PAGE.replace("First idea", "Mine again"), pages.markdown["p1"])
        vm.close()
    }

    @Test fun `a block keeps what this app cannot show when another block is edited`() = runTest(dispatcher) {
        val teal = "Mind the <span data-color=\"teal\">teal</span> note"
        pages.put("p1", "$teal\n\nSecond")
        val vm = loaded()
        typed(vm, 1, "Second edited")
        assertEquals("$teal\n\nSecond edited", pages.markdown["p1"])
        vm.close()
    }

    @Test fun `a Journal period without a page is created only by its first change`() = runTest(dispatcher) {
        journal.onPeriod = { content(periodPage(it, markdown = null, itemId = null)) }
        journal.onEnsure = {
            pages.put("j1", "")
            content("j1")
        }
        val source = NoteEditorSource.Journal(JournalPeriodKind.DAY, "2026-11-19")
        val vm = loaded(source)
        assertEquals(listOf(NoteEditorBlockType.TEXT), vm.state.value.blocks.map { it.type })
        advanceTimeBy(5_000)
        assertTrue(journal.ensureCalls.isEmpty())
        typed(vm, 0, "Dear diary")
        assertEquals(JournalPeriodType.DAY, journal.ensureCalls.single().type)
        assertEquals("Dear diary", pages.markdown["j1"])
        vm.close()
    }

    @Test fun `a Journal page another device created meanwhile is shown and not written over`() = runTest(dispatcher) {
        journal.onPeriod = { content(periodPage(it, markdown = null, itemId = null)) }
        journal.onEnsure = {
            pages.put("j1", "From the laptop")
            content("j1")
        }
        val vm = loaded(NoteEditorSource.Journal(JournalPeriodKind.DAY, "2026-11-19"))
        typed(vm, 0, "Mine")
        assertEquals("From the laptop", pages.markdown["j1"])
        assertEquals(NoteEditorProblem.RELOADED, vm.state.value.problem)
        vm.close()
    }

    @Test fun `kept text is handed to its owner after the pause and not on opening`() = runTest(dispatcher) {
        val vm = loaded(NoteEditorSource.Text("Buy **milk**"))
        val received = effects(vm)
        advanceTimeBy(5_000)
        assertTrue(received.isEmpty())
        vm.onAction(NoteEditorAction.Enter(vm.block(0).id, 12))
        settle()
        val changed = received.single() as NoteEditorEffect.TextChanged
        assertTrue(changed.markdown.startsWith("Buy **milk**\n\n"))
        assertEquals(2, vm.state.value.blocks.size)
        assertTrue(pages.calls.isEmpty())
        vm.close()
    }
}
