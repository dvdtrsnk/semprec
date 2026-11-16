package cz.semprec.app.data

import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailAddress
import cz.semprec.app.domain.MailDraft
import cz.semprec.app.domain.MailDraftMode
import cz.semprec.app.domain.MailFolder
import cz.semprec.app.domain.MailLink
import cz.semprec.app.domain.MailLinkBreaker
import cz.semprec.app.domain.MailLinkKind
import cz.semprec.app.domain.MailNamedRef
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailSummary
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.MailThreadSummary

internal fun MailAddressDto.toDomain() = MailAddress(name, address)

internal fun MailNamedDto.toDomain() = MailNamedRef(id, name)

private const val LINK_INHERITED = "inherited"
private const val LINK_BROKEN = "inheritedBroken"
private const val LINK_DERIVED = "derived"
private const val BROKEN_BY_USER = "user"
private const val BROKEN_BY_AGENT = "agent"

/** A value link of the wire; a kind this app does not know reads as no link. */
internal fun ValueLinkDto?.toMailLink(): MailLink? {
    val kind = when (this?.valueKind) {
        LINK_INHERITED -> MailLinkKind.INHERITED
        LINK_BROKEN -> MailLinkKind.BROKEN
        LINK_DERIVED -> MailLinkKind.DERIVED
        else -> null
    }
    val breaker = when (this?.brokenBy) {
        BROKEN_BY_USER -> MailLinkBreaker.USER
        BROKEN_BY_AGENT -> MailLinkBreaker.AGENT
        else -> null
    }
    val titles = this?.sources.orEmpty().mapNotNull { it.title?.takeIf(String::isNotEmpty) }
    return kind?.let { MailLink(it, titles, breaker) }
}

internal fun MailThreadDto.toDomain() = MailThreadSummary(
    threadId = threadId,
    subject = subject,
    lastMessageAt = lastMessageAt,
    senderName = lastSender.name,
    senderAddress = lastSender.address,
    senderRelationship = senderPerson?.relationship,
    messageCount = messageCount,
    preview = preview,
    hasAttachment = hasAttachment,
    unread = unread,
    flagged = flagged,
    mailboxNames = mailboxes.map { it.name },
    project = project?.toDomain(),
    company = company?.toDomain(),
    hasSempDraft = hasSempDraft,
)

internal fun MailSummaryDto.toDomain() = MailSummary(
    unreadInbox = unreadInbox,
    flagged = flagged,
    sempDrafts = sempDrafts,
    accounts = accounts,
    needingReauthorization = accountsNeedingReauth.map { it.toDomain() },
)

internal fun MailDraftDto.toDomain() = MailDraft(
    id = id,
    mailboxId = mailboxId,
    from = from,
    to = to.map { it.toDomain() },
    cc = cc.map { it.toDomain() },
    bcc = bcc.map { it.toDomain() },
    subject = subject,
    body = body,
    threadId = threadId,
    mode = when (mode) {
        MailDraftModeDto.NEW -> MailDraftMode.NEW
        MailDraftModeDto.REPLY -> MailDraftMode.REPLY
        MailDraftModeDto.REPLY_ALL -> MailDraftMode.REPLY_ALL
        MailDraftModeDto.FORWARD -> MailDraftMode.FORWARD
    },
    sourceEmailId = sourceEmailId,
    createdByAgent = createdBy == MailActorDto.AGENT,
    version = updatedAt,
)

internal fun MailMailboxDto.toDomain() = MailAccount(
    id = id,
    name = name,
    provider = provider,
    primaryAddress = primaryAddress,
    syncMode = syncMode,
    // A mailbox that finished its first sync and has no stored problem is in order.
    syncStatus = when (syncStatus) {
        null, MailSyncStatusDto.OK -> MailSyncStatus.OK
        MailSyncStatusDto.ERROR -> MailSyncStatus.ERROR
        MailSyncStatusDto.NEVER -> MailSyncStatus.NEVER
        MailSyncStatusDto.NEEDS_REAUTHORIZATION -> MailSyncStatus.NEEDS_REAUTHORIZATION
    },
    initialSyncInProgress = initialSyncInProgress,
    lastSuccessfulSyncAt = lastSuccessfulSyncAt,
    failingSince = failingSince,
    connectionLimit = connectionLimit.value,
    connectionLimitApplies = connectionLimit.applies,
    autonomousSendProjectCount = autonomousSendProjectCount,
)

internal fun MailFolderDto.toDomain() = MailFolder(id, name, specialPurpose, unreadCount, totalCount)

internal fun MailRemovalImpactDto.toDomain() = MailRemovalImpact(messages, drafts, threads, attachmentsKept)
