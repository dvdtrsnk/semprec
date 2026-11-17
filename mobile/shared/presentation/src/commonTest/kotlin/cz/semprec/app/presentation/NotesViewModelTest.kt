package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.NoteBlockType
import cz.semprec.app.domain.NoteBlock
import cz.semprec.app.domain.NotePage
import cz.semprec.app.domain.NotePlacement
import cz.semprec.app.domain.NotesRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun block(
    id: String,
    type: NoteBlockType = NoteBlockType.TEXT,
    indent: Int = 0,
    text: String = id,
    pageId: String? = null,
    done: Boolean = false,
) = NoteBlock(id, type, indent, done, text, pageId)

private val PAGE = NotePage(
    "Notes",
    listOf(
        block("h", NoteBlockType.H1),
        block("n1", NoteBlockType.NUMBER),
        block("n2", NoteBlockType.NUMBER),
        block("n21", NoteBlockType.NUMBER, indent = 1),
        block("n22", NoteBlockType.NUMBER, indent = 1),
        block("t", NoteBlockType.TEXT),
        block("n3", NoteBlockType.NUMBER),
        block("todo", NoteBlockType.TODO, done = true),
        block("sub", NoteBlockType.PAGE, text = "Sub", pageId = "page-1"),
    ),
)

private class ScriptedNotes(
    reads: List<ScriptedStep<NotePage>> = listOf({ RepositoryResult.Content(PAGE) }),
    private val write: ScriptedStep<Unit> = { RepositoryResult.Content(Unit) },
) : NotesRepository {
    val readCalls = CallScript(reads)
    val writes = mutableListOf<String>()

    override suspend fun read(itemId: String) = readCalls.next()

    override suspend fun insert(itemId: String, placement: NotePlacement, markdown: String): RepositoryResult<Unit> {
        writes += "insert:$itemId:$placement:$markdown"
        return write()
    }

    override suspend fun createSubpage(
        itemId: String,
        afterBlockId: String?,
        title: String?,
        fromBlockIds: List<String>,
    ): RepositoryResult<Unit> {
        writes += "subpage:$itemId:$afterBlockId:$title:$fromBlockIds"
        return write()
    }

    override suspend fun convertToBlock(
        itemId: String,
        blockId: String,
        type: NoteBlockType,
        confirmedPageCount: Int,
    ): RepositoryResult<Unit> {
        writes += "convert:$itemId:$blockId:$type:$confirmedPageCount"
        return write()
    }

    override suspend fun rename(pageItemId: String, title: String): RepositoryResult<Unit> {
        writes += "rename:$pageItemId:$title"
        return write()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class NotesViewModelTest : MainDispatcherTest() {
    private fun viewModel(notes: ScriptedNotes) = NotesViewModelFactory(notes).notesViewModel("item-1")

    private suspend fun TestScope.effectsOf(vm: NotesViewModel): List<NotesEffect> {
        val received = mutableListOf<NotesEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        return received
    }

    @Test fun `loads the page and numbers the numbered blocks level by level`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedNotes())
        assertEquals(NotesState(), vm.state.value)
        runCurrent()
        val state = vm.state.value
        assertEquals(NotesPhase.CONTENT, state.phase)
        assertEquals("Notes", state.title)
        assertEquals(
            listOf(null, "1.", "2.", "2.1.", "2.2.", null, "1.", null, null),
            state.blocks.map { it.marker },
        )
        assertEquals(true, state.blocks.first { it.id == "todo" }.done)
        assertEquals("page-1", state.blocks.last().pageId)
        vm.close()
    }

    @Test fun `a deeper numbered block under no number and an indent beyond the model are numbered sensibly`() =
        runTest(dispatcher) {
            val page = NotePage(
                "N",
                listOf(
                    block("a", NoteBlockType.NUMBER, indent = 1),
                    block("b", NoteBlockType.NUMBER, indent = 9),
                ),
            )
            val vm = viewModel(ScriptedNotes(reads = listOf({ RepositoryResult.Content(page) })))
            runCurrent()
            assertEquals(listOf("1.", "1.1."), vm.state.value.blocks.map { it.marker })
            vm.close()
        }

    @Test fun `an empty page is content with no blocks`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedNotes(reads = listOf({ RepositoryResult.Content(NotePage("Notes", emptyList())) })))
        runCurrent()
        assertEquals(NotesState(NotesPhase.CONTENT, title = "Notes"), vm.state.value)
        vm.close()
    }

    @Test fun `a failed load is an error with its kind and retry loads again`() = runTest(dispatcher) {
        val notes = ScriptedNotes(
            reads = listOf({ RepositoryResult.Failure(FailureKind.NOT_FOUND) }, { RepositoryResult.Content(PAGE) }),
        )
        val vm = viewModel(notes)
        runCurrent()
        assertEquals(NotesState(NotesPhase.ERROR, FailureKind.NOT_FOUND), vm.state.value)
        vm.onAction(NotesAction.Retry)
        assertEquals(NotesState(), vm.state.value)
        runCurrent()
        assertEquals(NotesPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedNotes(reads = listOf(crashes())))
        runCurrent()
        assertEquals(NotesState(NotesPhase.ERROR, null), vm.state.value)
        vm.close()
    }

    @Test fun `a refresh keeps the page while it reloads and a failed one leaves it as it was`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val notes = ScriptedNotes(
            reads = listOf(
                { RepositoryResult.Content(PAGE) },
                {
                    gate.await()
                    RepositoryResult.Failure(FailureKind.UNAVAILABLE)
                },
            ),
        )
        val vm = viewModel(notes)
        runCurrent()
        val loaded = vm.state.value
        vm.onAction(NotesAction.Refresh)
        assertEquals(loaded, vm.state.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `a refresh without a page is a retry`() = runTest(dispatcher) {
        val notes = ScriptedNotes(
            reads = listOf({ RepositoryResult.Failure(FailureKind.UNAVAILABLE) }, { RepositoryResult.Content(PAGE) }),
        )
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.Refresh)
        assertEquals(NotesPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(NotesPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a newer read cancels the one before and a late answer is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val notes = ScriptedNotes(
            reads = listOf(
                answersLate(gate, RepositoryResult.Content(NotePage("Stale", emptyList()))),
                { RepositoryResult.Content(PAGE) },
            ),
        )
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals("Notes", vm.state.value.title)
        vm.close()
    }

    @Test fun `a new block is inserted as markdown after a block or at the end and the page is read again`() =
        runTest(dispatcher) {
            val notes = ScriptedNotes()
            val vm = viewModel(notes)
            runCurrent()
            vm.onAction(NotesAction.Add(NoteBlockType.TODO, " buy milk ", "t"))
            assertTrue(vm.state.value.working)
            runCurrent()
            vm.onAction(NotesAction.Add(NoteBlockType.H2, "Heading", null))
            runCurrent()
            assertEquals(
                listOf("insert:item-1:After(blockId=t):- [ ] buy milk", "insert:item-1:End:## Heading"),
                notes.writes,
            )
            assertEquals(3, notes.readCalls.calls)
            assertEquals(false, vm.state.value.working)
            vm.close()
        }

    @Test fun `every type of block is written as its own markdown`() = runTest(dispatcher) {
        val notes = ScriptedNotes()
        val vm = viewModel(notes)
        runCurrent()
        NoteBlockType.entries.forEach {
            vm.onAction(NotesAction.Add(it, "x", null))
            runCurrent()
        }
        assertEquals(
            listOf("x", "# x", "## x", "### x", "- x", "1. x", "- [ ] x", "> x").map { "insert:item-1:End:$it" },
            notes.writes,
        )
        vm.close()
    }

    @Test fun `a blank text and a subpage type add nothing`() = runTest(dispatcher) {
        val notes = ScriptedNotes()
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "   ", null))
        vm.onAction(NotesAction.Add(NoteBlockType.PAGE, "Sub", null))
        runCurrent()
        assertTrue(notes.writes.isEmpty())
        vm.close()
    }

    @Test fun `an empty subpage is created after a block and the page is read again`() = runTest(dispatcher) {
        val notes = ScriptedNotes()
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.CreateSubpage("Ideas", "t"))
        runCurrent()
        assertEquals(listOf("subpage:item-1:t:Ideas:[]"), notes.writes)
        assertEquals(2, notes.readCalls.calls)
        vm.close()
    }

    @Test fun `chosen blocks move into subpages and the choice ends with it`() = runTest(dispatcher) {
        val notes = ScriptedNotes()
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.ToggleSelecting)
        assertTrue(vm.state.value.selecting)
        vm.onAction(NotesAction.Toggle("t"))
        vm.onAction(NotesAction.Toggle("h"))
        vm.onAction(NotesAction.Toggle("sub"))
        vm.onAction(NotesAction.Toggle("nope"))
        assertEquals(listOf("t", "h"), vm.state.value.selected)
        vm.onAction(NotesAction.Toggle("t"))
        assertEquals(listOf("h"), vm.state.value.selected)
        vm.onAction(NotesAction.Toggle("t"))
        vm.onAction(NotesAction.MoveSelectedToSubpages)
        runCurrent()
        assertEquals(listOf("subpage:item-1:null:null:[h, t]"), notes.writes)
        assertEquals(false, vm.state.value.selecting)
        assertTrue(vm.state.value.selected.isEmpty())
        vm.close()
    }

    @Test fun `ending the choice forgets it and moving nothing sends nothing`() = runTest(dispatcher) {
        val notes = ScriptedNotes()
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.ToggleSelecting)
        vm.onAction(NotesAction.Toggle("t"))
        vm.onAction(NotesAction.ToggleSelecting)
        assertEquals(false, vm.state.value.selecting)
        assertTrue(vm.state.value.selected.isEmpty())
        vm.onAction(NotesAction.MoveSelectedToSubpages)
        runCurrent()
        assertTrue(notes.writes.isEmpty())
        vm.close()
    }

    @Test fun `a chosen block that is gone after the reload is dropped from the choice`() = runTest(dispatcher) {
        val shorter = NotePage("Notes", listOf(block("h", NoteBlockType.H1)))
        val notes =
            ScriptedNotes(reads = listOf({ RepositoryResult.Content(PAGE) }, { RepositoryResult.Content(shorter) }))
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.ToggleSelecting)
        vm.onAction(NotesAction.Toggle("t"))
        vm.onAction(NotesAction.Toggle("h"))
        vm.onAction(NotesAction.Refresh)
        runCurrent()
        assertEquals(listOf("h"), vm.state.value.selected)
        vm.close()
    }

    @Test fun `a subpage block opens its page and any other block or unknown id does nothing`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedNotes())
        runCurrent()
        vm.onAction(NotesAction.Open("sub"))
        vm.onAction(NotesAction.Open("t"))
        vm.onAction(NotesAction.Open("nope"))
        vm.onAction(NotesAction.OpenAsText)
        assertEquals(listOf(NotesEffect.OpenPage("page-1"), NotesEffect.OpenAsText), effectsOf(vm))
        assertTrue(effectsOf(vm).isEmpty(), "A delivered effect is not delivered again")
        vm.close()
    }

    @Test fun `a subpage block is turned into a block and any other block or type is refused before a request`() =
        runTest(dispatcher) {
            val notes = ScriptedNotes()
            val vm = viewModel(notes)
            runCurrent()
            vm.onAction(NotesAction.ConvertToBlock("sub", NoteBlockType.BULLET))
            runCurrent()
            vm.onAction(NotesAction.ConvertToBlock("t", NoteBlockType.BULLET))
            vm.onAction(NotesAction.ConvertToBlock("sub", NoteBlockType.PAGE))
            runCurrent()
            assertEquals(listOf("convert:item-1:sub:BULLET:1"), notes.writes)
            vm.close()
        }

    @Test fun `a subpage is renamed by its page id and a blank title or another block is ignored`() =
        runTest(dispatcher) {
            val notes = ScriptedNotes()
            val vm = viewModel(notes)
            runCurrent()
            vm.onAction(NotesAction.RenameSubpage("sub", " New name "))
            runCurrent()
            vm.onAction(NotesAction.RenameSubpage("sub", "  "))
            vm.onAction(NotesAction.RenameSubpage("t", "x"))
            runCurrent()
            assertEquals(listOf("rename:page-1:New name"), notes.writes)
            vm.close()
        }

    @Test fun `a refused change leaves the page as it was and says why until dismissed`() = runTest(dispatcher) {
        val notes = ScriptedNotes(write = { RepositoryResult.Failure(FailureKind.REJECTED) })
        val vm = viewModel(notes)
        runCurrent()
        val loaded = vm.state.value
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "x", null))
        runCurrent()
        assertEquals(loaded.copy(writeFailure = Failed(FailureKind.REJECTED)), vm.state.value)
        assertEquals(1, notes.readCalls.calls)
        vm.onAction(NotesAction.DismissFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a crashing change is a failure without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedNotes(write = { error("unexpected") }))
        runCurrent()
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "x", null))
        runCurrent()
        assertEquals(Failed(null), vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a change whose reload fails keeps the old page and says why`() = runTest(dispatcher) {
        val notes = ScriptedNotes(
            reads = listOf({ RepositoryResult.Content(PAGE) }, { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }),
        )
        val vm = viewModel(notes)
        runCurrent()
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "x", null))
        runCurrent()
        assertEquals(NotesPhase.CONTENT, vm.state.value.phase)
        assertEquals(PAGE.blocks.size, vm.state.value.blocks.size)
        assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        assertEquals(false, vm.state.value.working)
        vm.close()
    }

    @Test fun `a change while another runs or before the page is shown sends nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val notes = ScriptedNotes(write = {
            gate.await()
            RepositoryResult.Content(Unit)
        })
        val vm = viewModel(notes)
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "early", null))
        runCurrent()
        assertTrue(notes.writes.isEmpty())
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "first", null))
        vm.onAction(NotesAction.Add(NoteBlockType.TEXT, "second", null))
        runCurrent()
        assertEquals(1, notes.writes.size)
        gate.complete(Unit)
        runCurrent()
        vm.close()
    }

    @Test fun `closing cancels the read and ignores later actions and clearing the store does the same`() =
        runTest(dispatcher) {
            val notes = ScriptedNotes(reads = listOf(neverAnswers()))
            val vm = viewModel(notes)
            runCurrent()
            vm.close()
            runCurrent()
            assertEquals(1, notes.readCalls.cancellations)
            vm.onAction(NotesAction.Retry)
            vm.onAction(NotesAction.OpenAsText)
            runCurrent()
            assertEquals(1, notes.readCalls.calls)
            assertTrue(vm.effects.toList().isEmpty())

            val stored = ScriptedNotes(reads = listOf(neverAnswers()))
            val store = ViewModelStore()
            val owned = store.provide { NotesViewModelFactory(stored).notesViewModel("item-1") }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(owned.isClosed)
            assertEquals(1, stored.readCalls.cancellations)
        }
}
