package cz.alldots.app.presentation

import cz.alldots.app.domain.MailAccount
import cz.alldots.app.domain.MailBox
import cz.alldots.app.domain.MailFacetOption
import cz.alldots.app.domain.MailSyncStatus
import cz.alldots.app.domain.MailThreadList
import cz.alldots.app.domain.MailThreadQuery
import cz.alldots.app.domain.MailThreadSummary
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException

/**
 * Runs a repository call and answers `null` when it crashed with an exception nobody expects, so that the screen can
 * show an error without a failure kind. Cancellation is never turned into an answer.
 */
internal suspend fun <T> mailAttempt(call: suspend () -> RepositoryResult<T>): RepositoryResult<T>? = try {
    call()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}

internal fun MailThreadSummary.toItem() = MailThreadItem(
    threadId = threadId,
    subject = subject,
    lastMessageAt = lastMessageAt,
    senderName = senderName,
    senderAddress = senderAddress,
    senderRelationship = senderRelationship,
    messageCount = messageCount,
    preview = preview,
    hasAttachment = hasAttachment,
    unread = unread,
    flagged = flagged,
    mailboxNames = mailboxNames,
    projectName = project?.name,
    companyName = company?.name,
    hasSempDraft = hasSempDraft,
)

internal fun MailFacetOption.toOption() = MailFilterOption(id, name, color, count)

internal fun MailListBox.toDomain(): MailBox = when (this) {
    MailListBox.INBOX -> MailBox.INBOX
    MailListBox.FLAGGED -> MailBox.FLAGGED
    MailListBox.SEMP_DRAFTS -> MailBox.SEMP_DRAFTS
}

/** The query of the list as the state shows it; a flagged filter reads the flagged box whatever box started it. */
internal fun MailThreadsState.toQuery(cursor: String?) = MailThreadQuery(
    box = if (filter == MailListFilter.FLAGGED) MailBox.FLAGGED else box.toDomain(),
    mailboxId = mailboxId,
    folderId = folderId,
    projectId = projectId,
    unreadOnly = filter == MailListFilter.UNREAD,
    search = search,
    cursor = cursor,
)

internal fun MailAccount.toChip() = MailMailboxChip(id, name)

internal fun MailAccount.needsReauthorization() = syncStatus == MailSyncStatus.NEEDS_REAUTHORIZATION

internal fun MailAccount.toNotice() = MailAccountNotice(id, name, failingSince)

/** The mailboxes [this] names, each with the name of its chip, or an empty one for a mailbox the list does not know. */
internal fun List<String>.named(chips: List<MailMailboxChip>): List<MailMailboxChip> =
    map { id -> chips.firstOrNull { it.id == id } ?: MailMailboxChip(id, "") }

/** The kept rows, shown until the server answers; a refresh of them is under way. */
internal fun MailThreadsState.withCached(kept: MailThreadList) = copy(
    phase = MailThreadsPhase.CONTENT,
    failure = null,
    refreshing = true,
    hasMore = kept.nextCursor != null,
    threads = kept.threads.map { it.toItem() },
    remoteSearch = null,
    fromCache = true,
)
