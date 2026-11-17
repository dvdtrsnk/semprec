package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.EditJournalPage
import cz.semprec.app.domain.LoadJournalPage
import cz.semprec.app.domain.PageEdit
import cz.semprec.app.domain.PageEditOutcome
import cz.semprec.app.domain.PageTarget
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * A subpage of the diary (a page block of a day, week or quarter) opened on its own: it reads the page of one item
 * and edits it the way the diary does, one change at a time.
 */
class JournalSubpageViewModel internal constructor(
    private val itemId: String,
    private val loadPage: LoadJournalPage,
    private val editPage: EditJournalPage,
) : ScreenViewModel<JournalSubpageState, JournalSubpageAction, JournalSubpageEffect>(JournalSubpageState()) {
    private var loadJob: Job? = null
    private var editJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: JournalSubpageAction) {
        if (isClosed) return
        when (action) {
            JournalSubpageAction.Retry -> load()
            is JournalSubpageAction.SetText -> setText(action)
            is JournalSubpageAction.ToggleDone -> toggleDone(action)
            is JournalSubpageAction.AddBlock -> addBlock(action)
            is JournalSubpageAction.OpenPage -> emit(JournalSubpageEffect.OpenPage(action.pageId, action.title))
            JournalSubpageAction.DismissProblem -> update { it.copy(editProblem = null, editFailure = null) }
        }
    }

    private fun load() {
        loadJob?.cancel()
        editJob?.cancel()
        update { JournalSubpageState() }
        loadJob = viewModelScope.launch {
            val result = try {
                loadPage(itemId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            update {
                when (result) {
                    is RepositoryResult.Content ->
                        JournalSubpageState(JournalPhase.CONTENT, blocks = markdownToBlocks(result.value.markdown))
                    is RepositoryResult.Failure -> JournalSubpageState(JournalPhase.ERROR, failure = result.kind)
                    null -> JournalSubpageState(JournalPhase.ERROR)
                }
            }
        }
    }

    private fun setText(action: JournalSubpageAction.SetText) {
        val block = state.value.blocks.getOrNull(action.index)
        val expected = block?.runs?.joinToString("") { it.text }
        if (block != null && block.kind != JournalBlockKind.PAGE && expected != action.text) {
            edit(PageEdit.SetText(action.index, expected.orEmpty(), action.text))
        }
    }

    private fun toggleDone(action: JournalSubpageAction.ToggleDone) {
        val block = state.value.blocks.getOrNull(action.index)
        if (block != null && block.kind == JournalBlockKind.TODO) {
            edit(PageEdit.ToggleDone(action.index, block.runs.joinToString("") { it.text }))
        }
    }

    private fun addBlock(action: JournalSubpageAction.AddBlock) {
        if (action.kind != JournalBlockKind.PAGE && action.text.isNotBlank()) {
            edit(PageEdit.Append(action.kind.toType(), action.text))
        }
    }

    private fun edit(change: PageEdit) {
        if (state.value.saving || state.value.phase != JournalPhase.CONTENT) return
        update { it.copy(saving = true, editProblem = null, editFailure = null) }
        editJob = viewModelScope.launch {
            val result = try {
                editPage(PageTarget.OfItem(itemId), change)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            update {
                when (result) {
                    is RepositoryResult.Content -> afterEdit(it, result.value)
                    is RepositoryResult.Failure ->
                        it.copy(saving = false, editProblem = JournalEditProblem.FAILED, editFailure = result.kind)
                    null -> it.copy(saving = false, editProblem = JournalEditProblem.FAILED)
                }
            }
        }
    }

    private fun afterEdit(state: JournalSubpageState, outcome: PageEditOutcome): JournalSubpageState = when (outcome) {
        is PageEditOutcome.Saved -> state.copy(saving = false, blocks = markdownToBlocks(outcome.markdown))
        PageEditOutcome.Stale -> state.copy(saving = false, editProblem = JournalEditProblem.STALE)
    }
}
