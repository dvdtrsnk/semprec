package cz.semprec.app.presentation

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class NoteEditorEditingTest : NoteEditorTest() {

    @Test fun `enter splits the block and puts the cursor at the start of the new one`() = runTest(dispatcher) {
        val vm = loaded()
        val request = vm.state.value.caretRequest
        vm.onAction(NoteEditorAction.Enter(vm.block(3).id, 2))
        assertEquals(listOf("Plan", "First idea", "one", "tw", "o"), vm.texts())
        assertEquals(NoteEditorBlockType.BULLET, vm.block(4).type)
        assertEquals(NoteEditorCaret(vm.block(4).id, 0), vm.state.value.caret)
        assertEquals(request + 1, vm.state.value.caretRequest)
        vm.close()
    }

    @Test fun `a typed Markdown prefix turns a text block into its type`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(NoteEditorAction.SetRuns(vm.block(1).id, listOf(NoteEditorRun("[x] First idea"))))
        assertEquals(NoteEditorBlockType.TODO, vm.block(1).type)
        assertTrue(vm.block(1).done)
        assertEquals("First idea", vm.texts()[1])
        assertEquals(NoteEditorCaret(vm.block(1).id, 0), vm.state.value.caret)
        vm.close()
    }

    @Test fun `a format without a word around the cursor waits for the next typed text`() = runTest(dispatcher) {
        val vm = loaded()
        val received = effects(vm)
        vm.onAction(NoteEditorAction.ToggleMark(vm.block(1).id, 5, 5, NoteEditorMark.BOLD))
        runCurrent()
        assertEquals(listOf<NoteEditorEffect>(NoteEditorEffect.PendingMark(NoteEditorMark.BOLD)), received)
        vm.onAction(NoteEditorAction.ToggleMark(vm.block(1).id, 2, 2, NoteEditorMark.BOLD))
        runCurrent()
        assertEquals(NoteEditorRun("First", bold = true), vm.block(1).runs.first())
        assertEquals(1, received.size)
        vm.close()
    }

    @Test fun `a link without a selection inserts its address and an existing link only changes it`() =
        runTest(dispatcher) {
            val vm = loaded()
            vm.onAction(NoteEditorAction.SetLink(vm.block(1).id, 0, 0, "semprec.cz"))
            assertEquals(NoteEditorRun("https://semprec.cz", link = "https://semprec.cz"), vm.block(1).runs.first())
            vm.onAction(NoteEditorAction.SetLink(vm.block(1).id, 3, 3, "https://other.cz"))
            assertEquals(NoteEditorRun("https://semprec.cz", link = "https://other.cz"), vm.block(1).runs.first())
            vm.onAction(NoteEditorAction.SetLink(vm.block(1).id, 3, 3, null))
            assertEquals(listOf(NoteEditorRun("https://semprec.czFirst idea")), vm.block(1).runs)
            vm.close()
        }

    @Test fun `a block becomes a subpage on the server and an empty one opens with its title focused`() =
        runTest(dispatcher) {
            val vm = loaded()
            val received = effects(vm)
            vm.onAction(NoteEditorAction.MakeSubpage(vm.block(1).id))
            assertTrue(vm.state.value.working)
            runCurrent()
            assertEquals(listOf("info p1", "read p1", "info p1", "subpage p1 s1", "info p1", "read p1"), pages.calls)
            assertEquals(NoteEditorBlockType.PAGE, vm.block(1).type)
            assertEquals("made-1", vm.block(1).pageId)
            assertTrue(received.isEmpty())
            vm.onAction(NoteEditorAction.TapBelow)
            vm.onAction(NoteEditorAction.MakeSubpage(vm.block(4).id))
            runCurrent()
            assertEquals(listOf<NoteEditorEffect>(NoteEditorEffect.OpenPage("made-4", "", focusTitle = true)), received)
            assertEquals(false, vm.state.value.working)
            vm.close()
        }

    @Test fun `copies of a subpage and of text land after the last chosen block`() = runTest(dispatcher) {
        pages.put("p1", "[Trip](semprec://page/t1)\n\nPack\n\nEnd")
        val vm = loaded()
        vm.onAction(NoteEditorAction.Duplicate(listOf(vm.block(0).id, vm.block(1).id)))
        runCurrent()
        assertEquals(listOf("Trip", "Pack", "Pack", "Trip (kopie)", "End"), vm.texts())
        assertEquals("t1-copy", vm.block(3).pageId)
        settle()
        assertTrue(pages.markdown.getValue("p1").contains("Pack\n\n[Trip (kopie)](semprec://page/t1-copy)\n\nEnd"))
        vm.close()
    }

    @Test fun `a page block opens its subpage and the page title is renamed on the server`() = runTest(dispatcher) {
        pages.put("p1", "[Trip](semprec://page/t1)")
        val vm = loaded()
        val received = effects(vm)
        vm.onAction(NoteEditorAction.OpenPage(vm.block(0).id))
        runCurrent()
        assertEquals(listOf<NoteEditorEffect>(NoteEditorEffect.OpenPage("t1", "Trip", focusTitle = false)), received)
        vm.onAction(NoteEditorAction.SetTitle("Renamed"))
        runCurrent()
        assertEquals("rename p1 Renamed", pages.calls.last())
        assertEquals("Renamed", vm.state.value.title)
        vm.close()
    }

    @Test fun `a block is never made a page by a change of type`() = runTest(dispatcher) {
        val vm = loaded()
        val before = vm.state.value.blocks
        vm.onAction(NoteEditorAction.SetType(listOf(vm.block(1).id), NoteEditorBlockType.PAGE))
        vm.onAction(NoteEditorAction.ToggleType(listOf(vm.block(1).id), NoteEditorBlockType.PAGE))
        assertEquals(before, vm.state.value.blocks)
        vm.onAction(NoteEditorAction.SetType(listOf(vm.block(1).id), NoteEditorBlockType.QUOTE))
        assertEquals(NoteEditorBlockType.QUOTE, vm.block(1).type)
        vm.close()
    }

    @Test fun `deleting the last block leaves one empty text block`() = runTest(dispatcher) {
        pages.put("p1", "Only")
        val vm = loaded()
        vm.onAction(NoteEditorAction.Delete(listOf(vm.block(0).id)))
        assertEquals(listOf(NoteEditorBlockType.TEXT), vm.state.value.blocks.map { it.type })
        assertEquals(listOf(""), vm.texts())
        vm.close()
    }
}
