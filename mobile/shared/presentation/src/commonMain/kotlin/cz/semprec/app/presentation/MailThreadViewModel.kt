package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailDraft
import cz.semprec.app.domain.MailDraftRepository
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailSentDraft
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * One mail thread with the reply Semp prepared as a draft. Opening a thread that is unread marks it read. A flag, a move
 * or a task is a request to the server; its failure is state, and a thread that was archived or trashed closes the
 * screen. Sending the draft saves the text first when the person changed it; an agent only proposes a send, so this
 * is always the person's own send.
 */
class MailThreadViewModel internal constructor(
    private val threadId: String,
    private val mail: MailRepository,
    private val drafts: MailDraftRepository,
) : ScreenViewModel<MailThreadState, MailThreadAction, MailThreadEffect>(MailThreadState()) {
    private var loadJob: Job? = null
    private var expanded: Set<String>? = null
    private var detail: MailThreadDetail? = null
    private var draft: MailDraft? = null

    init {
        load(showWait = true)
    }

    override fun onAction(action: MailThreadAction) {
        if (isClosed) return
        when (action) {
            MailThreadAction.Retry -> load(showWait = true)
            MailThreadAction.Refresh -> load(showWait = state.value.phase != MailThreadPhase.CONTENT)
            is MailThreadAction.ToggleMessage -> toggleMessage(action.emailId)
            MailThreadAction.ToggleFlag -> toggleFlag()
            is MailThreadAction.Move -> move(action.to)
            is MailThreadAction.SendDraft -> sendDraft(action.body)
            MailThreadAction.AddTask -> addTask()
            is MailThreadAction.Open -> open(action.target)
            MailThreadAction.DismissFailure -> update { it.copy(actionFailed = false, actionRefusal = null) }
        }
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) MailThreadState(sentFrom = it.sentFrom) else it.copy(refreshing = true) }
        loadJob = viewModelScope.launch {
            val result = mailAttempt { mail.thread(threadId) }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> {
                    val sempDraft = result.value.messages.lastOrNull { it.isDraft() }
                        ?.let { readSempDraft(it.emailId) }
                    ensureActive()
                    show(result.value, sempDraft)
                }
                is RepositoryResult.Failure -> update { it.failedLoad(result.kind) }
                null -> update { it.failedLoad(null) }
            }
        }
    }

    private fun show(loaded: MailThreadDetail, sempDraft: MailDraft?) {
        detail = loaded
        draft = sempDraft
        val open = expanded ?: loaded.defaultExpanded()
        expanded = open
        update { loaded.toState(open, sempDraft?.toSempDraft(), it) }
        // Opening a thread reads it; when the server refuses, the thread stays unread, which the list shows.
        if (loaded.unread) viewModelScope.launch { mailWrite { mail.setRead(threadId, read = true) } }
    }

    /** The draft is Semp's only when an agent made it; the person's own drafts are not offered as a reply. */
    private suspend fun readSempDraft(emailId: String): MailDraft? =
        (mailAttempt { drafts.read(emailId) } as? RepositoryResult.Content)?.value?.takeIf { it.createdByAgent }

    private fun open(target: MailThreadTarget) {
        val effect = when (target) {
            MailThreadTarget.Draft -> draft?.let { MailThreadEffect.Compose(MailComposeStart.Draft(it.id)) }
            is MailThreadTarget.Reply -> detail?.replyEffect(target.mode)
            is MailThreadTarget.Task -> MailThreadEffect.OpenTask(target.taskId)
        }
        if (effect != null) emit(effect)
    }

    private fun toggleMessage(emailId: String) {
        val open = expanded.orEmpty().let { if (emailId in it) it - emailId else it + emailId }
        expanded = open
        update { it.copy(messages = it.messages.map { m -> m.copy(expanded = m.emailId in open) }) }
    }

    private fun toggleFlag() {
        val flagged = state.value.flagged
        update { it.copy(flagged = !flagged) }
        viewModelScope.launch {
            val result = mailWrite { mail.setFlagged(threadId, flagged = !flagged) }
            ensureActive()
            when (result) {
                is MailWrite.Done -> update { it.copy(flagged = result.value) }
                is MailWrite.Failed -> update {
                    it.copy(flagged = flagged, actionFailed = true, actionRefusal = result.refusal)
                }
            }
        }
    }

    private fun move(to: MailThreadMove) {
        if (state.value.acting) return
        update { it.copy(acting = true) }
        viewModelScope.launch {
            val result = mailWrite {
                when (to) {
                    MailThreadMove.ARCHIVE -> mail.archive(threadId)
                    MailThreadMove.TRASH -> mail.trash(threadId)
                    MailThreadMove.RESTORE -> mail.restore(threadId)
                }
            }
            ensureActive()
            update {
                it.copy(
                    acting = false,
                    actionFailed = result is MailWrite.Failed,
                    actionRefusal = (result as? MailWrite.Failed)?.refusal,
                )
            }
            if (result is MailWrite.Done) {
                if (to == MailThreadMove.RESTORE) load(showWait = false) else emit(MailThreadEffect.Close)
            }
        }
    }

    private fun addTask() {
        if (state.value.creatingTask) return
        update { it.copy(creatingTask = true) }
        viewModelScope.launch {
            val result = mailAttempt { mail.createTask(threadId) }
            ensureActive()
            update {
                it.copy(
                    creatingTask = false,
                    actionFailed = result !is RepositoryResult.Content,
                    actionRefusal = null,
                )
            }
            if (result is RepositoryResult.Content) load(showWait = false)
        }
    }

    private fun sendDraft(body: String) {
        val current = draft
        if (current == null || state.value.sendPhase == MailSendPhase.SENDING) return
        update { it.copy(sendPhase = MailSendPhase.SENDING, sendFailure = null, sendRefusal = null) }
        viewModelScope.launch {
            val saved = if (body == current.body) {
                MailWrite.Done(current)
            } else {
                mailWrite { drafts.update(current.id, current.version, current.fields(body)) }
            }
            val sent: MailWrite<MailSentDraft> = when (saved) {
                is MailWrite.Done -> {
                    draft = saved.value
                    mailWrite { drafts.send(saved.value.id) }
                }
                is MailWrite.Failed -> saved
            }
            ensureActive()
            afterSend(sent)
        }
    }

    private fun afterSend(sent: MailWrite<MailSentDraft>) {
        when (sent) {
            is MailWrite.Done -> {
                draft = null
                update {
                    it.copy(
                        sendPhase = MailSendPhase.SENT,
                        sentFrom = sent.value.mailboxName,
                        draft = null,
                    )
                }
                load(showWait = false)
            }
            is MailWrite.Failed -> update {
                it.copy(sendPhase = MailSendPhase.FAILED, sendFailure = sent.failure, sendRefusal = sent.refusal)
            }
        }
    }
}

/** A failed first load is an error; a failed refresh leaves the thread that is shown as it was. */
private fun MailThreadState.failedLoad(kind: FailureKind?): MailThreadState =
    if (phase == MailThreadPhase.CONTENT) {
        copy(refreshing = false, actionFailed = true, actionRefusal = null)
    } else {
        copy(phase = MailThreadPhase.ERROR, failure = kind)
    }

private fun MailThreadDetail.replyEffect(mode: MailReplyMode): MailThreadEffect? {
    val source = replySource()
    val mailboxId = source?.mailboxId
    return if (source != null && mailboxId != null) {
        MailThreadEffect.Compose(MailComposeStart.Reply(source.emailId, mailboxId, mode))
    } else {
        null
    }
}
