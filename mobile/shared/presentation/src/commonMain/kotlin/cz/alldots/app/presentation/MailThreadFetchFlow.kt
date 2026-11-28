package cz.alldots.app.presentation

import cz.alldots.app.domain.MailContentRepository
import cz.alldots.app.domain.MailThreadDetail
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The bodies a thread fetches from the mail provider and the attachments it saves into Files. Each message and each
 * attachment keeps its own state in [fetches], which the thread lays over what the server sent ([messageItems]); a
 * fetch or a save holds up nothing else. [detail] and [expanded] read the thread the screen shows.
 */
internal class MailThreadFetchFlow(
    private val host: FlowHost<MailThreadState, MailThreadEffect>,
    private val content: MailContentRepository,
    private val detail: () -> MailThreadDetail?,
    private val expanded: () -> Set<String>,
) {
    var fetches = MailThreadFetches()
        private set

    /** Fetches the body of [emailId] when it is only at the provider and neither fetched nor being fetched. */
    fun fetchBody(emailId: String) {
        val message = detail()?.shownMessages()?.firstOrNull { it.emailId == emailId }
        val known = fetches.bodies[emailId]
        val needed = message?.isRemote() == true && (known == null || known is MailBodyFetch.Failed)
        if (!needed) return
        change { it.copy(bodies = it.bodies + (emailId to MailBodyFetch.Loading)) }
        host.scope.launch {
            val result = mailFetch { content.messageContent(emailId) }
            ensureActive()
            val fetched = when (result) {
                is MailFetch.Done -> MailBodyFetch.Loaded(result.value.bodyText)
                is MailFetch.Failed -> MailBodyFetch.Failed(result.failure, result.unavailable)
            }
            change { it.copy(bodies = it.bodies + (emailId to fetched)) }
        }
    }

    /** Saves the attachment [attachmentId] of the shown message [emailId], unless it is being saved already. */
    fun saveAttachment(emailId: String, attachmentId: String) {
        val message = detail()?.shownMessages()?.firstOrNull { it.emailId == emailId }
        val known = message != null && message.attachments.any { it.attachmentId == attachmentId }
        if (!known || fetches.saves[attachmentId] == MailAttachmentSave.Saving) return
        change { it.copy(saves = it.saves + (attachmentId to MailAttachmentSave.Saving)) }
        host.scope.launch {
            val result = mailFetch { content.saveAttachment(emailId, attachmentId) }
            ensureActive()
            val saved = when (result) {
                is MailFetch.Done -> MailAttachmentSave.Saved(result.value)
                is MailFetch.Failed -> MailAttachmentSave.Failed(result.failure, result.unavailable)
            }
            change { it.copy(saves = it.saves + (attachmentId to saved)) }
        }
    }

    /** Records what was fetched or saved and, while the thread is shown, shows its messages again with it. */
    private fun change(transform: (MailThreadFetches) -> MailThreadFetches) {
        fetches = transform(fetches)
        val shown = detail() ?: return
        val open = expanded()
        host.update {
            if (it.phase == MailThreadPhase.CONTENT) it.copy(messages = shown.messageItems(open, fetches)) else it
        }
    }
}
