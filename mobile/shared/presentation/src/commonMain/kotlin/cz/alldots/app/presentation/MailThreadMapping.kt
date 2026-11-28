package cz.alldots.app.presentation

import cz.alldots.app.domain.MailAddress
import cz.alldots.app.domain.MailDraft
import cz.alldots.app.domain.MailDraftFields
import cz.alldots.app.domain.MailMessage
import cz.alldots.app.domain.MailThreadDetail
import cz.alldots.app.domain.MailThreadTask

private const val DRAFTS = "drafts"
private const val ARCHIVE = "archive"
private const val TRASH = "trash"
private const val TASK_DONE = "done"

internal fun MailMessage.isDraft() = folderPurpose == DRAFTS

internal fun MailAddress.label() = name.ifBlank { address }

private fun MailThreadTask.toItem() = MailTaskItem(
    id = id,
    name = name,
    date = date,
    done = status == TASK_DONE,
    project = MailLinkedValue(projectName, projectLink.toInfo()),
    peopleNames = peopleNames,
    peopleLink = peopleLink.toInfo(),
)

/** The message a reply answers: the last one that is not the person's own, else the last one that is not a draft. */
internal fun MailThreadDetail.replySource(): MailMessage? {
    val sent = messages.filterNot { it.isDraft() }
    return sent.lastOrNull { !it.own } ?: sent.lastOrNull()
}

/** The messages the screen shows: every one but the drafts. */
internal fun MailThreadDetail.shownMessages(): List<MailMessage> = messages.filterNot { it.isDraft() }

/** The ids of the messages the screen shows open: the last one that is not a draft. */
internal fun MailThreadDetail.defaultExpanded(): Set<String> =
    messages.lastOrNull { !it.isDraft() }?.let { setOf(it.emailId) }.orEmpty()

internal fun MailThreadDetail.toState(
    expanded: Set<String>,
    fetches: MailThreadFetches,
    draft: MailSempDraft?,
    previous: MailThreadState,
): MailThreadState {
    val shown = shownMessages()
    val purposes = shown.mapNotNull { it.folderPurpose }
    return previous.copy(
        phase = MailThreadPhase.CONTENT,
        failure = null,
        refreshing = false,
        subject = subject,
        senderName = senderName.ifBlank { senderAddress },
        senderAddress = senderAddress,
        senderRelationship = senderRelationship,
        mailboxNames = mailboxNames,
        messageCount = messageCount,
        flagged = flagged,
        company = MailLinkedValue(company?.name, companyLink.toInfo()),
        project = MailLinkedValue(project?.name, projectLink.toInfo()),
        messages = messageItems(expanded, fetches),
        tasks = tasks.map { it.toItem() },
        draft = draft,
        archivedOrTrashed = purposes.isNotEmpty() && purposes.size == shown.size &&
            purposes.all { it == ARCHIVE || it == TRASH },
        canReply = replySource()?.mailboxId != null,
    )
}

internal fun MailDraft.toSempDraft() = MailSempDraft(id, body, to.map { it.label() })

internal fun MailDraft.fields(body: String = this.body) =
    MailDraftFields(mailboxId, from, to, cc, bcc, subject, body)
