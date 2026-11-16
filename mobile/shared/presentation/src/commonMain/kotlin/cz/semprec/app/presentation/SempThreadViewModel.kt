package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.LoadOlderSempMessages
import cz.semprec.app.domain.LoadSempRunSteps
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/** Where a chat opens and what it already knows about the thread, as the screen that opened it knows it. */
internal class SempThreadOrigin(
    val start: SempThreadStart,
    val threadId: String?,
    val inboxItemId: String?,
    val subject: SempSubject?,
)

/** What a chat reads and writes besides the thread itself. */
internal class SempThreadServices(
    val reader: SempThreadReader,
    val send: SempSendCases,
    val older: LoadOlderSempMessages,
    val steps: LoadSempRunSteps,
    val approvals: SempApprovalFlow,
)

private fun initialData(origin: SempThreadOrigin) = SempThreadData(
    type = if (origin.start == SempThreadStart.ITEM) SempThreadType.ITEM else SempThreadType.CHAT,
    subject = origin.subject,
)

/**
 * A conversation with Semp: the latest chat, a new one, a given thread, the thread of an Inbox item, or the thread of
 * an automatic task. A message goes out as a local entry that shows as sending until the server has it, or as failed
 * with a retry; the reply is made by the server in the background, so the screen asks again, sooner at first, until
 * the reply is there. The server does not stream.
 */
class SempThreadViewModel internal constructor(
    private val origin: SempThreadOrigin,
    private val session: SempSession,
    private val services: SempThreadServices,
) : ScreenViewModel<SempThreadState, SempThreadAction, SempThreadEffect>(initialData(origin).render()) {
    private val store = SempThreadStore(viewModelScope, initialData(origin)) { next -> update { next } }
    private val loader = SempThreadLoader(store, services.reader, services.older)
    private val sender = SempThreadSender(store, loader, session, origin.inboxItemId, services.send)
    private val details = SempThreadDetails(store, loader, services.steps, services.approvals)
    private var loadJob: Job? = null

    init {
        session.attachments.onEach { store.change { copy(attachments = it) } }.launchIn(viewModelScope)
        session.closed.onEach { store.change { copy(closedNotices = it) } }.launchIn(viewModelScope)
        load()
    }

    override fun onAction(action: SempThreadAction) {
        if (isClosed) return
        when (action) {
            SempThreadAction.Retry -> load()
            SempThreadAction.Refresh -> loader.refreshNow()
            is SempThreadAction.Send -> sender.send(action.text)
            is SempThreadAction.ResolveUnsent -> sender.resolveUnsent(action.id, action.retry)
            is SempThreadAction.AskAgain -> sender.reply(action.messageId, action.regenerate)
            is SempThreadAction.ToggleRun -> details.toggleRun(action.messageId)
            is SempThreadAction.Decide -> details.decide(action.approvalId, action.approve)
            SempThreadAction.LoadOlder -> loader.loadOlder()
            SempThreadAction.RunAgain -> sender.runAgain()
            is SempThreadAction.Dismiss -> dismiss(action)
            is SempThreadAction.Open -> open(action)
        }
    }

    private fun dismiss(action: SempThreadAction.Dismiss) = when (action) {
        SempThreadAction.Dismiss.Notice -> store.data.summary?.bannerProblemId?.let(session::closeNotice) ?: Unit
        SempThreadAction.Dismiss.Failure -> store.change { copy(actionFailed = false, actionFailure = null) }
        is SempThreadAction.Dismiss.Attachment -> session.unstage(setOf(action.key))
    }

    private fun open(action: SempThreadAction.Open) = emit(
        when (action) {
            is SempThreadAction.Open.Run -> SempThreadEffect.OpenRun(action.runId, action.messageId)
            is SempThreadAction.Open.Change -> SempThreadEffect.OpenItem(action.itemId, action.databaseKey)
            SempThreadAction.Open.Approvals -> SempThreadEffect.OpenApprovals
            SempThreadAction.Open.Status -> SempThreadEffect.OpenStatus
            SempThreadAction.Open.History -> SempThreadEffect.OpenHistory
            SempThreadAction.Open.NewChat -> SempThreadEffect.OpenNewChat
        },
    )

    private fun load() {
        loadJob?.cancel()
        loader.stopPolling()
        store.change { copy(phase = SempThreadPhase.LOADING, failure = null) }
        loadJob = viewModelScope.launch {
            val opened = services.reader.open(origin.start, origin.threadId, origin.inboxItemId)
            currentCoroutineContext().ensureActive()
            when (opened) {
                is SempOpened.Found -> {
                    loader.adopt(opened.conversation)
                    if (origin.start == SempThreadStart.LATEST) loader.notice()
                }
                SempOpened.Empty -> store.change { copy(phase = SempThreadPhase.READY) }
                is SempOpened.Failed -> store.change { copy(phase = SempThreadPhase.ERROR, failure = opened.kind) }
            }
        }
    }
}
