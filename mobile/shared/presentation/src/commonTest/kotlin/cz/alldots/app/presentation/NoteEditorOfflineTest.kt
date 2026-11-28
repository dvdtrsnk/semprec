package cz.alldots.app.presentation

import cz.alldots.app.domain.PageWrite
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** What the note editor does with a write that was merged or kept on the device, and with a page changed elsewhere. */
@OptIn(ExperimentalCoroutinesApi::class)
class NoteEditorOfflineTest : NoteEditorTest() {
    private val changes = MutableSharedFlow<String>(extraBufferCapacity = 8)

    private fun TestScope.following() = NoteEditorViewModel(
        NoteEditorSource.Page("p1", titleEditable = true),
        pages,
        journal,
        NoteEditorSettings(saveDelayMillis = 700, now = { "NOW" }),
        changes,
    ).also { runCurrent() }

    @Test fun `a merged write shows the merge in place and keeps the blocks it left unchanged`() = runTest(dispatcher) {
        val vm = loaded()
        val ids = vm.state.value.blocks.map { it.id }
        pages.writeAnswer = { _, markdown -> PageWrite.Merged("\"m1\"", "$markdown\n\nFrom the phone") }
        typed(vm, 1, "First idea, refined")
        assertEquals(listOf("Plan", "First idea, refined", "one", "two", "From the phone"), vm.texts())
        assertEquals(ids, vm.state.value.blocks.take(4).map { it.id })
        assertNull(vm.state.value.problem)
        assertFalse(vm.state.value.saving)
        assertEquals(1, pages.calls.count { it.startsWith("replace") })
    }

    @Test fun `the next write after a merge goes against the version and the text of the merge`() =
        runTest(dispatcher) {
            val vm = loaded()
            pages.writeAnswer = { _, markdown -> PageWrite.Merged("\"m1\"", "$markdown\n\nFrom the phone") }
            typed(vm, 1, "Second")
            pages.writeAnswer = { _, _ -> PageWrite.Saved("\"m2\"") }
            typed(vm, 1, "Third")
            assertEquals("replace p1 \"m1\"", pages.calls.last { it.startsWith("replace") })
            assertEquals("# Plan\n\nSecond\n\n- one\n- two\n\nFrom the phone", pages.bases.last())
        }

    @Test fun `every write names the text it was edited from`() = runTest(dispatcher) {
        val vm = loaded()
        typed(vm, 1, "Second")
        typed(vm, 1, "Third")
        assertEquals(listOf(NOTE_PAGE, "# Plan\n\nSecond\n\n- one\n- two"), pages.bases)
    }

    @Test fun `a change typed while a merged write was under way is merged into it and written after the pause`() =
        runTest(dispatcher) {
            val vm = loaded()
            val gate = CompletableDeferred<Unit>()
            pages.replaceGate = gate
            pages.writeAnswer = { _, markdown -> PageWrite.Merged("\"m1\"", "$markdown\n\nFrom the phone") }
            typed(vm, 1, "Typed first")
            vm.onAction(NoteEditorAction.SetRuns(vm.block(3).id, listOf(NoteEditorRun("typed meanwhile"))))
            runCurrent()
            pages.replaceGate = null
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf("Plan", "Typed first", "one", "typed meanwhile", "From the phone"), vm.texts())
            assertTrue(vm.state.value.saving)
            pages.writeAnswer = null
            pages.put("p1", pages.markdown.getValue("p1"))
            settle()
            assertTrue(pages.calls.count { it.startsWith("replace") } >= 2)
        }

    @Test fun `a write kept on the device counts as saved and the next one goes against the version read`() =
        runTest(dispatcher) {
            val vm = loaded()
            pages.writeAnswer = { _, _ -> PageWrite.Kept }
            typed(vm, 1, "Offline")
            assertFalse(vm.state.value.saving)
            assertNull(vm.state.value.problem)
            assertEquals("NOW", vm.state.value.lastEditedAt)
            typed(vm, 1, "Offline again")
            val replaced = pages.calls.filter { it.startsWith("replace") }
            assertEquals(listOf("replace p1 \"v1\"", "replace p1 \"v1\""), replaced)
            assertEquals("# Plan\n\nOffline\n\n- one\n- two", pages.bases.last())
        }

    @Test fun `a page changed elsewhere is read again when its item is named`() = runTest(dispatcher) {
        val vm = following()
        pages.put("p1", "# Plan\n\nChanged on the Mac")
        changes.tryEmit("p1")
        runCurrent()
        assertEquals(listOf("Plan", "Changed on the Mac"), vm.texts())
    }

    @Test fun `a page read again keeps the ids of the blocks it holds unchanged`() = runTest(dispatcher) {
        val vm = following()
        val ids = vm.state.value.blocks.map { it.id }
        pages.put("p1", "$NOTE_PAGE\n\nAdded on the Mac")
        changes.tryEmit("p1")
        runCurrent()
        assertEquals(listOf("Plan", "First idea", "one", "two", "Added on the Mac"), vm.texts())
        assertEquals(ids, vm.state.value.blocks.take(ids.size).map { it.id })
    }

    @Test fun `a page read again as it is shown changes nothing`() = runTest(dispatcher) {
        val vm = following()
        val shown = vm.state.value
        changes.tryEmit("p1")
        runCurrent()
        assertEquals(shown, vm.state.value)
        assertEquals(2, pages.calls.count { it == "read p1" })
    }

    @Test fun `a change of another page is not read`() = runTest(dispatcher) {
        val vm = following()
        val before = pages.calls.size
        changes.tryEmit("p2")
        runCurrent()
        assertEquals(before, pages.calls.size)
        assertEquals(listOf("Plan", "First idea", "one", "two"), vm.texts())
    }

    @Test fun `a page waiting to write its change is not read again when it is named`() = runTest(dispatcher) {
        val vm = following()
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("Waiting"))))
        runCurrent()
        pages.put("p1", "# Plan\n\nChanged on the Mac")
        val reads = pages.calls.count { it.startsWith("read") }
        changes.tryEmit("p1")
        runCurrent()
        assertEquals(reads, pages.calls.count { it.startsWith("read") })
        assertEquals("Waiting", vm.texts()[1])
    }

    @Test fun `a closed editor reads nothing when its page is named`() = runTest(dispatcher) {
        val vm = following()
        vm.close()
        val before = pages.calls.size
        changes.tryEmit("p1")
        runCurrent()
        assertEquals(before, pages.calls.size)
    }
}
