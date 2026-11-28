package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.MailAccount
import cz.alldots.app.domain.MailAddress
import cz.alldots.app.domain.MailDraft
import cz.alldots.app.domain.MailDraftFields
import cz.alldots.app.domain.MailDraftMode
import cz.alldots.app.domain.MailDraftRepository
import cz.alldots.app.domain.MailPrefill
import cz.alldots.app.domain.MailSentDraft
import cz.alldots.app.domain.MailboxRepository
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val SUGGESTION_DELAY_MILLIS = 250L
private val ADDRESS_PATTERN = Regex("^[^\\s@,]+@[^\\s@,]+$")

/**
 * A new message, the reply to one, or a saved draft. A new message becomes a draft on the server when it is sent; a reply
 * is a draft from the start, because the server writes its recipients, subject and quote. Sending always goes through
 * the draft as the person: update with the text, then send. A draft that was made only for this screen is discarded when
 * the person leaves without sending it; a draft that was already there (Semp's) is left alone.
 */
class MailComposeViewModel internal constructor(
    private val start: MailComposeStart,
    private val drafts: MailDraftRepository,
    private val mailboxes: MailboxRepository,
) : ScreenViewModel<MailComposeState, MailComposeAction, MailComposeEffect>(MailComposeState()) {
    private var loadJob: Job? = null
    private var suggestJob: Job? = null
    private var draft: MailDraft? = null
    private var madeHere = false

    init {
        load()
    }

    override fun onAction(action: MailComposeAction) {
        if (isClosed) return
        when (action) {
            MailComposeAction.Retry -> load()
            is MailComposeAction.SearchContacts -> searchContacts(action.text.trim())
            is MailComposeAction.AddRecipient -> addRecipient(MailRecipient(action.name, action.address))
            is MailComposeAction.AddAddress -> addAddress(action.text.trim())
            is MailComposeAction.RemoveRecipient -> update {
                it.copy(
                    to = it.to.filterNot { r -> r.address == action.address },
                    cc = it.cc.filterNot { r -> r.address == action.address },
                )
            }
            is MailComposeAction.SelectSender -> update { it.copy(senderId = action.mailboxId) }
            is MailComposeAction.Send -> send(action.subject, action.body)
            MailComposeAction.Cancel -> cancel()
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { MailComposeState() }
        loadJob = viewModelScope.launch {
            val accounts = mailAttempt { mailboxes.mailboxes() }
            val prepared: MailWrite<MailDraft?> = when (accounts) {
                is RepositoryResult.Content -> prepare()
                is RepositoryResult.Failure -> MailWrite.Failed(accounts.kind)
                null -> MailWrite.Failed(null)
            }
            ensureActive()
            val senders = (accounts as? RepositoryResult.Content)?.value.orEmpty().toSenders()
            when (prepared) {
                is MailWrite.Done -> {
                    draft = prepared.value
                    update { it.ready(senders, prepared.value) }
                }
                is MailWrite.Failed -> update {
                    it.copy(phase = MailComposePhase.ERROR, failure = prepared.failure, refusal = prepared.refusal)
                }
            }
        }
    }

    /** The draft the screen starts from, or none for a blank message. */
    private suspend fun prepare(): MailWrite<MailDraft?> = when (start) {
        MailComposeStart.New -> MailWrite.Done(null)
        is MailComposeStart.Reply -> {
            val prefill = MailPrefill(start.mailboxId, start.mode.toDraftMode(), start.sourceEmailId, body = "")
            val created = mailWrite { drafts.createPrefilled(prefill) }
            if (created is MailWrite.Done) madeHere = true
            created
        }
        is MailComposeStart.Draft -> mailAttempt { drafts.read(start.draftId) }.toWrite()
    }

    private fun searchContacts(text: String) {
        suggestJob?.cancel()
        if (text.isEmpty()) {
            update { it.copy(suggestions = emptyList()) }
            return
        }
        val taken = state.value.let { current -> (current.to + current.cc).map { it.address } }
        suggestJob = viewModelScope.launch {
            delay(SUGGESTION_DELAY_MILLIS)
            val result = mailAttempt { drafts.contacts(text, taken) }
            ensureActive()
            val found = (result as? RepositoryResult.Content)?.value.orEmpty()
            update { it.copy(suggestions = found.map { c -> MailSuggestion(c.name, c.address, c.relationship) }) }
        }
    }

    private fun addAddress(text: String) {
        if (ADDRESS_PATTERN.matches(text)) {
            addRecipient(MailRecipient("", text))
        } else {
            update { it.copy(invalidAddress = true) }
        }
    }

    private fun addRecipient(recipient: MailRecipient) {
        suggestJob?.cancel()
        update {
            val known = (it.to + it.cc).any { r -> r.address.equals(recipient.address, ignoreCase = true) }
            it.copy(
                to = if (known) it.to else it.to + recipient,
                suggestions = emptyList(),
                invalidAddress = false,
            )
        }
    }

    private fun send(subject: String, body: String) {
        val current = state.value
        val sender = current.senders.firstOrNull { it.mailboxId == current.senderId }
        if (sender == null || current.to.isEmpty() || current.sendPhase == MailSendPhase.SENDING) return
        update { it.copy(sendPhase = MailSendPhase.SENDING, sendFailure = null, sendRefusal = null) }
        val fields = MailDraftFields(
            mailboxId = sender.mailboxId,
            from = sender.address,
            to = current.to.map { MailAddress(it.name, it.address) },
            cc = current.cc.map { MailAddress(it.name, it.address) },
            bcc = draft?.bcc.orEmpty(),
            subject = subject,
            body = body,
        )
        viewModelScope.launch {
            val saved = save(fields)
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

    /** Updates the draft this screen has, or makes one of a blank message. */
    private suspend fun save(fields: MailDraftFields): MailWrite<MailDraft> {
        val existing = draft
        if (existing != null) return mailWrite { drafts.update(existing.id, existing.version, fields) }
        val created = mailWrite { drafts.create(fields, threadId = null) }
        if (created is MailWrite.Done) madeHere = true
        return created
    }

    private fun afterSend(sent: MailWrite<MailSentDraft>) {
        when (sent) {
            is MailWrite.Done -> {
                draft = null
                update { it.copy(sendPhase = MailSendPhase.SENT, sentFrom = sent.value.mailboxName) }
            }
            is MailWrite.Failed -> update {
                it.copy(sendPhase = MailSendPhase.FAILED, sendFailure = sent.failure, sendRefusal = sent.refusal)
            }
        }
    }

    /** Only a draft that this screen made and did not send is discarded, and only once. */
    private fun needsDiscard(): Boolean {
        val current = state.value
        return madeHere && !current.discardFailed && current.sendPhase != MailSendPhase.SENT
    }

    private fun cancel() {
        val unsent = draft
        if (unsent == null || !needsDiscard()) {
            emit(MailComposeEffect.Close)
            return
        }
        viewModelScope.launch {
            val result = mailAttempt { drafts.discard(unsent.id) }
            ensureActive()
            if (result is RepositoryResult.Content) {
                emit(MailComposeEffect.Close)
            } else {
                update { it.copy(discardFailed = true) }
            }
        }
    }
}

private fun List<MailAccount>.toSenders(): List<MailSender> =
    mapNotNull { account -> account.primaryAddress?.let { MailSender(account.id, account.name, it) } }

private fun MailReplyMode.toDraftMode() = when (this) {
    MailReplyMode.REPLY -> MailDraftMode.REPLY
    MailReplyMode.REPLY_ALL -> MailDraftMode.REPLY_ALL
    MailReplyMode.FORWARD -> MailDraftMode.FORWARD
}

private fun MailComposeState.ready(senders: List<MailSender>, draft: MailDraft?): MailComposeState {
    val known = senders.toMutableList()
    if (draft != null && known.none { it.mailboxId == draft.mailboxId }) {
        known += MailSender(draft.mailboxId, draft.from, draft.from)
    }
    return copy(
        phase = MailComposePhase.EDITING,
        failure = null,
        refusal = null,
        senders = known,
        senderId = draft?.mailboxId ?: known.firstOrNull()?.mailboxId,
        to = draft?.to.orEmpty().map { MailRecipient(it.name, it.address) },
        cc = draft?.cc.orEmpty().map { MailRecipient(it.name, it.address) },
        initialSubject = draft?.subject.orEmpty(),
        initialBody = draft?.body.orEmpty(),
    )
}
