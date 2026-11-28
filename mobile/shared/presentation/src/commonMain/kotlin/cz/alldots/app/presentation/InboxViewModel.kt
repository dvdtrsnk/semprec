package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.InboxAttachment
import cz.alldots.app.domain.InboxCardStatus
import cz.alldots.app.domain.InboxContent
import cz.alldots.app.domain.InboxOrigin
import cz.alldots.app.domain.carrying
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The Inbox: a stack of cards the person approves, edits or discards. The cards, their fields and what each field
 * allows come from the server and the domain; this decides what the screen shows and passes each action to the flow
 * that owns it. Expected failures are state, cancellation is not; a retry or a refresh supersedes the load before it.
 * While Semp computes a card the stack is read again every few seconds, so that its proposal appears by itself.
 */
class InboxViewModel internal constructor(
    dependencies: InboxDependencies,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<InboxState, InboxAction, InboxEffect>(InboxState()) {
    private val model = InboxModel()
    private val deps = dependencies
    private val context = InboxFlowContext(
        host = FlowHost(viewModelScope, { state.value }, { transform -> update(transform) }, { emit(it) }),
        model = model,
        deps = deps,
        reload = { load(showWait = false) },
    )
    private val edits = InboxEditFlow(context)
    private val decisions = InboxDecisionFlow(context)
    private val options = InboxOptionsFlow(context)
    private val previews = AttachmentPreviews(viewModelScope, deps.openAttachment) { preview ->
        update { it.copy(attachment = preview) }
    }
    private var loadJob: Job? = null
    private var pollJob: Job? = null

    init {
        reloadOnChanges(changes) { onAction(InboxAction.Refresh) }
        load(showWait = true)
    }

    override fun onAction(action: InboxAction) {
        if (isClosed) return
        when (action) {
            InboxAction.Retry -> load(showWait = true)
            InboxAction.Refresh -> load(showWait = state.value.phase != InboxPhase.CONTENT)
            is InboxAction.SetText, is InboxAction.SetFlag, is InboxAction.SetDate, is InboxAction.SetTime,
            is InboxAction.Pick, is InboxAction.Toggle, is InboxAction.SetSecret,
            -> edits.handle(action)
            is InboxAction.OpenPicker, InboxAction.ClosePicker -> options.handle(action)
            InboxAction.Approve, InboxAction.Reject, InboxAction.Undo, is InboxAction.Recompute, is InboxAction.Reset,
            InboxAction.OpenResult, InboxAction.DismissResult, InboxAction.DismissProblem,
            -> decisions.handle(action)
            is InboxAction.OpenAttachment -> previews.open(action.attachmentId, attachment(action))
            InboxAction.CloseAttachment -> previews.close()
        }
        options.prefetch()
    }

    /** The attachment of the source of a card of the stack. */
    private fun attachment(action: InboxAction.OpenAttachment): InboxAttachment? =
        (model.card(action.cardId)?.origin as? InboxOrigin.Capture)
            ?.attachments
            ?.firstOrNull { it.id == action.attachmentId }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        update {
            if (showWait) InboxState(handled = it.handled, dropped = it.dropped) else it.copy(refreshing = true)
        }
        loadJob = viewModelScope.launch {
            val loaded = answer { deps.load() }
            ensureActive()
            when (loaded) {
                is Answer.Done -> show(loaded.value)
                is Answer.Rejected -> update { it.failedLoad(loaded.kind) }
            }
        }
    }

    private fun show(content: InboxContent) {
        val previous = model.cards.associateBy { it.id }
        model.cards = content.stack.cards.map { it.carrying(previous[it.id]) }
        model.types = content.types
        model.prune()
        context.render { it.copy(phase = InboxPhase.CONTENT, failure = null, refreshing = false) }
        options.prefetch()
        pollWhileComputing()
    }

    /** A failed first load is an error; a failed refresh leaves the cards that are shown as they were. */
    private fun InboxState.failedLoad(kind: FailureKind?): InboxState =
        if (phase == InboxPhase.CONTENT) {
            copy(refreshing = false)
        } else {
            InboxState(phase = InboxPhase.ERROR, failure = kind)
        }

    private fun pollWhileComputing() {
        pollJob?.cancel()
        if (model.cards.none { it.status == InboxCardStatus.COMPUTING }) return
        pollJob = viewModelScope.launch {
            delay(POLL_MILLIS)
            if (loadJob?.isActive != true) load(showWait = false)
        }
    }

    private companion object {
        const val POLL_MILLIS = 3_000L
    }
}
