package cz.semprec.app.data

import cz.semprec.app.domain.MailAttachment
import cz.semprec.app.domain.MailMessage
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.MailThreadTask

private const val TRASHED = "trashed"

private fun MailAttachmentDto.toDomain() = MailAttachment(
    filename = filename,
    contentType = contentType,
    byteSize = byteSize,
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
