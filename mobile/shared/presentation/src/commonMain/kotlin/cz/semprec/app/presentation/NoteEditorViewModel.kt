package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.PageBlockType
import cz.semprec.app.domain.note.NotePageRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * One note: a page of an item, the page of a Journal period, or Markdown its owner keeps. Every edit is applied by
 * the document rules of the domain, shown at once and written after a pause in typing (see [NotePageStore]). When
 * [pageChanges] names the item of the page shown, the page is read again quietly, unless a change waits to be
 * written.
 */
class NoteEditorViewModel internal constructor(
    source: NoteEditorSource,
    pages: NotePageRepository,
    journal: JournalRepository,
    settings: NoteEditorSettings,
    pageChanges: Flow<String> = emptyFlow(),
) : ScreenViewModel<NoteEditorState, NoteEditorAction, NoteEditorEffect>(NoteEditorState()) {
    private var lastId = 0
    private val newId: () -> String = { "note-${++lastId}" }
    private val host = FlowHost<NoteEditorState, NoteEditorEffect>(
        viewModelScope,
        { state.value },
        { update(it) },
        { emit(it) },
    )
    private val repositories = NoteRepositories(pages, journal)
    private val store =
        NotePageStore(host, source, repositories, NoteReads(source, repositories), newId, settings)
    private val subpages = NoteSubpageFlow(host, store, pages, newId)

    init {
        store.load()
        // A page the server holds a newer version of is read again in place, unless a change waits to be written.
        viewModelScope.launch { pageChanges.collect { itemId -> if (itemId == store.itemId) store.reread() } }
    }

    override fun onAction(action: NoteEditorAction) {
        if (isClosed) return
        when (action) {
            NoteEditorAction.Retry -> store.load()
            NoteEditorAction.Refresh -> store.reread()
            NoteEditorAction.DismissProblem -> update { it.copy(problem = null, problemFailure = null) }
            NoteEditorAction.Flush -> store.flush()
            is NoteEditorAction.MakeSubpage -> subpages.makeSubpage(action.blockId)
            is NoteEditorAction.OpenPage -> subpages.open(action.blockId)
            is NoteEditorAction.SetTitle -> subpages.rename(action.title)
            is NoteEditorAction.Duplicate -> duplicate(action)
            else -> edit(action)
        }
    }

    private fun duplicate(action: NoteEditorAction.Duplicate) {
        val ids = action.blockIds.toSet()
        if (store.blocks.any { it.id in ids && it.type == PageBlockType.PAGE }) {
            if (isEditable()) subpages.duplicate(ids)
        } else {
            edit(action)
        }
    }

    private fun edit(action: NoteEditorAction) {
        if (!isEditable()) return
        val reduction = NoteEditorReducer.typing(store.blocks, action, newId)
            ?: NoteEditorReducer.structure(store.blocks, action, newId)
            ?: return
        if (reduction.blocks != store.blocks) store.change(reduction.blocks)
        if (reduction.movesCaret) {
            val caret = reduction.caret?.let { NoteEditorCaret(it.blockId, it.offset) }
            update { it.copy(caret = caret, caretRequest = it.caretRequest + 1) }
        }
        reduction.pendingMark?.let { emit(NoteEditorEffect.PendingMark(it)) }
    }

    private fun isEditable(): Boolean = state.value.phase == NoteEditorPhase.CONTENT && !state.value.working
}
