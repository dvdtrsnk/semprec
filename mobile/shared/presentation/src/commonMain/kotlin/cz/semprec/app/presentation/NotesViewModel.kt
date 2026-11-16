package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.NoteBlockType
import cz.semprec.app.domain.NoteBlock
import cz.semprec.app.domain.NotePage
import cz.semprec.app.domain.NotePlacement
import cz.semprec.app.domain.NotesRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.noteMarkdown
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val LEVELS = 6
private const val SHOWN_PAGE_COUNT = 1

/**
 * The page of notes of [itemId]: the blocks as the server holds them, new blocks and subpages, blocks moved into
 * subpages and subpages turned back into blocks. Every change is a request and the page is read again after it, so
 * what is shown is what the server holds. A newer read supersedes the one before it.
 */
class NotesViewModel internal constructor(
    private val itemId: String,
    private val notes: NotesRepository,
) : ScreenViewModel<NotesState, NotesAction, NotesEffect>(NotesState()) {
    private var loadJob: Job? = null

    init {
        read(showWait = true)
    }

    override fun onAction(action: NotesAction) {
        if (isClosed) return
        when (action) {
            NotesAction.Retry -> read(showWait = true)
            NotesAction.Refresh -> read(showWait = state.value.phase != NotesPhase.CONTENT)
            is NotesAction.Add -> add(action)
            is NotesAction.CreateSubpage -> createSubpage(action)
            NotesAction.ToggleSelecting -> update { it.copy(selecting = !it.selecting, selected = emptyList()) }
            is NotesAction.Toggle -> toggle(action.blockId)
            NotesAction.MoveSelectedToSubpages -> moveSelected()
            is NotesAction.Open -> open(action.blockId)
            is NotesAction.ConvertToBlock -> convert(action)
            is NotesAction.RenameSubpage -> rename(action)
            NotesAction.OpenAsText -> emit(NotesEffect.OpenAsText)
            NotesAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun blockOf(id: String, type: NoteBlockType? = null): NoteBlockItem? =
        state.value.blocks.firstOrNull { it.id == id && (type == null || it.type == type) }

    private fun createSubpage(action: NotesAction.CreateSubpage) {
        change { notes.createSubpage(itemId, action.afterBlockId, action.title, emptyList()) }
    }

    private fun open(blockId: String) {
        val pageId = blockOf(blockId, NoteBlockType.PAGE)?.pageId ?: return
        emit(NotesEffect.OpenPage(pageId))
    }

    private fun add(action: NotesAction.Add) {
        val markdown = noteMarkdown(action.type, action.text.trim())
        if (markdown == null || action.text.isBlank()) return
        val placement = action.afterBlockId?.let { NotePlacement.After(it) } ?: NotePlacement.End
        change { notes.insert(itemId, placement, markdown) }
    }

    private fun toggle(blockId: String) {
        update { current ->
            when {
                current.blocks.none { it.id == blockId && it.type != NoteBlockType.PAGE } -> current
                blockId in current.selected -> current.copy(selected = current.selected - blockId)
                else -> current.copy(selected = current.selected + blockId)
            }
        }
    }

    private fun moveSelected() {
        val chosen = state.value.selected
        if (chosen.isEmpty()) return
        change(afterwards = { it.copy(selecting = false, selected = emptyList()) }) {
            notes.createSubpage(itemId, null, null, chosen)
        }
    }

    private fun convert(action: NotesAction.ConvertToBlock) {
        if (action.type == NoteBlockType.PAGE || blockOf(action.blockId, NoteBlockType.PAGE) == null) return
        change { notes.convertToBlock(itemId, action.blockId, action.type, SHOWN_PAGE_COUNT) }
    }

    private fun rename(action: NotesAction.RenameSubpage) {
        val pageId = blockOf(action.blockId, NoteBlockType.PAGE)?.pageId ?: return
        if (action.title.isBlank()) return
        change { notes.rename(pageId, action.title.trim()) }
    }

    private fun read(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) NotesState() else it }
        loadJob = viewModelScope.launch {
            val result = answer { notes.read(itemId) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> result.value.toState(it)
                    is Answer.Rejected ->
                        if (it.phase == NotesPhase.CONTENT) it else NotesState(NotesPhase.ERROR, result.kind)
                }
            }
        }
    }

    /** Runs a change, then reads the page again; a change that fails leaves the page as it was and says why. */
    private fun change(afterwards: (NotesState) -> NotesState = { it }, call: suspend () -> RepositoryResult<Unit>) {
        if (state.value.working || state.value.phase != NotesPhase.CONTENT) return
        update { it.copy(working = true, writeFailure = null) }
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            val result = answer { call() }
            ensureActive()
            when (result) {
                is Answer.Rejected -> update { it.copy(working = false, writeFailure = Failed(result.kind)) }
                is Answer.Done -> {
                    val page = answer { notes.read(itemId) }
                    ensureActive()
                    update { current ->
                        val written = afterwards(current).copy(working = false)
                        when (page) {
                            is Answer.Done -> page.value.toState(written)
                            is Answer.Rejected -> written.copy(writeFailure = Failed(page.kind))
                        }
                    }
                }
            }
        }
    }
}

private fun NotePage.toState(current: NotesState): NotesState {
    val ids = blocks.map { it.id }.toSet()
    return current.copy(
        phase = NotesPhase.CONTENT,
        failure = null,
        title = title,
        blocks = blocks.withMarkers(),
        selected = current.selected.filter { it in ids },
    )
}

/** The blocks with the number each numbered block shows; a deeper level starts again after a shallower block. */
private fun List<NoteBlock>.withMarkers(): List<NoteBlockItem> {
    val counts = IntArray(LEVELS)
    return map { block ->
        val level = block.indent.coerceIn(0, LEVELS - 1)
        for (deeper in level + 1 until LEVELS) counts[deeper] = 0
        val marker = if (block.type == NoteBlockType.NUMBER) {
            counts[level] += 1
            (0..level).map { counts[it] }.filter { it > 0 }.joinToString(".") + "."
        } else {
            counts[level] = 0
            null
        }
        NoteBlockItem(block.id, block.type, block.indent, block.done, block.text, block.pageId, marker)
    }
}
