package cz.semprec.app.data

import cz.semprec.app.domain.MailAttachment
import cz.semprec.app.domain.MailContentState
import cz.semprec.app.domain.MailMessage
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.MailThreadTask

private const val TRASHED = "trashed"

private fun MailAttachmentDto.toDomain() = MailAttachment(
    attachmentId = attachmentId,
    filename = filename,
    contentType = contentType,
    byteSize = byteSize,
    stored = stored,
    blobId = blobId,
    fileItemId = fileItemId,
    project = project?.toDomain(),
    projectLink = links.project.toMailLink(),
)

private fun MailMessageDto.toDomain() = MailMessage(
    emailId = emailId,
    mailboxId = mailboxId,
    folderPurpose = folderPurpose,
    own = isOwn,
    from = from?.toDomain(),
    to = to.map { it.toDomain() },
    cc = cc.map { it.toDomain() },
    date = date,
    bodyText = bodyText,
    contentState = when (contentState) {
        MailContentStateDto.FULL -> MailContentState.FULL
        MailContentStateDto.CACHED -> MailContentState.CACHED
        MailContentStateDto.REMOTE -> MailContentState.REMOTE
    },
    preview = preview,
    read = read,
    attachments = attachments.map { it.toDomain() },
)

private fun MailTaskDto.toDomain() = MailThreadTask(
    id = id,
    name = name,
    date = date,
    status = status,
    projectName = project?.takeIf { it.state != TRASHED }?.name,
    projectLink = links.project.toMailLink(),
    peopleNames = people.filter { it.state != TRASHED }.mapNotNull { it.name },
    peopleLink = links.people.toMailLink(),
)

internal fun MailThreadDetailDto.toDomain() = MailThreadDetail(
    threadId = threadId,
    subject = subject,
    messageCount = messageCount,
    unread = unread,
    flagged = flagged,
    mailboxNames = mailboxes.map { it.name },
    senderName = lastSender.name,
    senderAddress = lastSender.address,
    senderRelationship = senderPerson?.relationship,
    project = project?.toDomain(),
    company = company?.toDomain(),
    projectLink = links.project.toMailLink(),
    companyLink = links.company.toMailLink(),
    messages = messages.map { it.toDomain() },
    tasks = tasks.map { it.toDomain() },
)
