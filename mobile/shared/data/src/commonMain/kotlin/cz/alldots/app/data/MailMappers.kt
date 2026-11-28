package cz.alldots.app.data

import cz.alldots.app.domain.CalendarSyncStatus
import cz.alldots.app.domain.InternetAccount
import cz.alldots.app.domain.MailAccount
import cz.alldots.app.domain.MailAddress
import cz.alldots.app.domain.MailDraft
import cz.alldots.app.domain.MailDraftMode
import cz.alldots.app.domain.MailFolder
import cz.alldots.app.domain.MailLink
import cz.alldots.app.domain.MailLinkBreaker
import cz.alldots.app.domain.MailLinkKind
import cz.alldots.app.domain.MailNamedRef
import cz.alldots.app.domain.MailRemovalImpact
import cz.alldots.app.domain.MailSummary
import cz.alldots.app.domain.MailSyncStatus
import cz.alldots.app.domain.MailThreadSummary

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
    version = version,
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
    syncedMessageCount = syncedMessageCount,
)

/**
 * The account side of a mailbox row. A row without a calendar status, or with one this app does not know, is off when
 * Calendars is switched off and pending otherwise.
 */
internal fun MailMailboxDto.toInternetAccount() = InternetAccount(
    mailbox = toDomain(),
    mailEnabled = mailEnabled,
    calendarsEnabled = calendarsEnabled,
    calendarStatus = CALENDAR_STATUSES[calendarStatus]
        ?: if (calendarsEnabled) CalendarSyncStatus.PENDING else CalendarSyncStatus.OFF,
)

private val CALENDAR_STATUSES = mapOf(
    "off" to CalendarSyncStatus.OFF,
    "pending" to CalendarSyncStatus.PENDING,
    "needsConsent" to CalendarSyncStatus.NEEDS_CONSENT,
    "ok" to CalendarSyncStatus.OK,
    "error" to CalendarSyncStatus.ERROR,
    "never" to CalendarSyncStatus.NEVER,
    "needsReauthorization" to CalendarSyncStatus.NEEDS_REAUTHORIZATION,
)

internal fun MailFolderDto.toDomain() = MailFolder(id, name, specialPurpose, unreadCount, totalCount)

internal fun MailRemovalImpactDto.toDomain() = MailRemovalImpact(messages, drafts, threads, attachmentsKept)
