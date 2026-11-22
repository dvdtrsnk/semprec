package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/** UIDs one `UID SEARCH` spans, below the folder's cursor. */
private const val SEARCH_SPAN = 2_000L

/** UIDs one `UID FETCH` asks for; below the 500 messages the server takes in one upload. */
private const val FETCH_UIDS = 200

/** The largest FETCH response the server takes (`MAIL_HISTORY_MAX_FETCH_BYTES`). */
private const val MAX_FETCH_BYTES = 64 * 1024

/** Base64 of the FETCH responses one upload carries, well under the server's 8 MiB body. */
private const val UPLOAD_BASE64_BUDGET = 6 * 1024 * 1024

/** What one message adds to an upload's body besides its base64: its UID twice and the JSON around them. */
private const val UPLOAD_MESSAGE_OVERHEAD = 48

private const val BASE64_GROUP_BYTES = 3
private const val BASE64_GROUP_CHARS = 4

/** Cursor moves under the device in a row after which a folder is left to the server. */
private const val MAX_STALE_IN_ROW = 3

/** A claim leases for 10 minutes (`MAIL_HISTORY_LEASE_MS`); it is renewed well before. */
private val RENEW_AFTER = 4.minutes
private val POLL_EVERY = 30.seconds
private val POLL_FOR = 20.minutes
private val RELEASE_TIMEOUT = 10.seconds

/** How far an indexing run got: folders finished of those leased so far, and messages the server accepted. */
data class MailHistoryProgress(val foldersDone: Int, val foldersTotal: Int, val messagesUploaded: Int)

/**
 * Why an indexing run ended: every leased folder was indexed or left to the server ([COMPLETE]); no folder could be
 * leased within the wait ([NOTHING_LEASED]); the server ended the lease ([LEASE_LOST]) or takes no history for the
 * mailbox ([UNAVAILABLE]); the IMAP server failed ([IMAP_FAILED]) or the Semprec server did ([SERVER_FAILED]).
 */
enum class MailHistoryIndexEnd { COMPLETE, NOTHING_LEASED, LEASE_LOST, UNAVAILABLE, IMAP_FAILED, SERVER_FAILED }

/**
 * Indexes the older history of an IMAP mailbox the person just connected, from the device, while [MailHistoryLogin]
 * is in memory: the server leases the folders whose history is index-only, and the device reads each one newest first
 * over one IMAP connection and uploads it slice by slice.
 *
 * A claim that leases nothing while the server still backfills some folder itself (as right after connecting) is
 * repeated every 30 s for up to 20 minutes. Each leased folder is opened read-only and indexed only while its
 * UIDVALIDITY is the one the server leased; from the server's cursor down, a `UID SEARCH` spans 2000 UIDs, whose
 * messages are fetched 200 at a time and uploaded in slices that stay well under the server's body limit, each slice
 * starting at the cursor the previous one left. A cursor the server reports elsewhere is taken over; a message the
 * upload cannot carry ends the device's work on that folder just above it, so the server's backfill continues there
 * once the lease ends. The lease is renewed by claiming again with the same token every 4 minutes, which also leases
 * folders that became index-only meanwhile. The run stops when the lease ends, when the mailbox takes no history, and
 * at the first failure of either server; whatever the end, also on cancellation, the leases are released.
 *
 * The login is held only by the running call: it is dropped when the call returns or is cancelled.
 */
class IndexMailHistory(
    private val history: MailHistoryRepository,
    private val imap: MailHistoryImap,
    private val timeSource: TimeSource = TimeSource.Monotonic,
) {
    suspend operator fun invoke(
        mailboxId: String,
        login: MailHistoryLogin,
        progress: (MailHistoryProgress) -> Unit,
    ): MailHistoryIndexEnd = when (val claim = history.claim(mailboxId, null)) {
        is RepositoryResult.Failure -> MailHistoryIndexEnd.SERVER_FAILED
        is RepositoryResult.Content -> {
            val lease = HistoryLease(mailboxId, claim.value.leaseToken, history, timeSource, progress)
            try {
                HistoryRun(lease, history, timeSource).index(claim.value, imap, login)
            } finally {
                lease.release()
            }
        }
    }
}

/** Where a folder's walk is: still due below [Continue.cursor], finished for the device, or the run's [Stop]. */
private sealed interface Step {
    data class Continue(val cursor: Long) : Step

    data object Finished : Step

    data class Stop(val end: MailHistoryIndexEnd) : Step
}

/** The cursor the server reported: due below it, or finished when it reports none. */
private fun continueAt(cursor: Long?): Step = if (cursor == null || cursor < 2) Step.Finished else Step.Continue(cursor)

/** One contiguous range `[low, high)` with the [items] in it, newest first. */
private class Range<T>(val high: Long, val low: Long, val items: List<T>)

/**
 * The ranges of [groups] (each newest first, the groups too) from [high] down to [low]: each starts where the one
 * before ends and ends at its own oldest item, the last at [low]. No group is one empty range.
 */
private fun <T> ranges(groups: List<List<T>>, high: Long, low: Long, uid: (T) -> Long): List<Range<T>> {
    if (groups.isEmpty()) return listOf(Range(high, low, emptyList()))
    var top = high
    return groups.mapIndexed { index, group ->
        val bottom = if (index == groups.lastIndex) low else uid(group.last())
        Range(top, bottom, group).also { top = bottom }
    }
}

/** Runs [step] on each range while the folder's cursor is still where the range starts. */
private suspend fun <T> along(ranges: List<Range<T>>, step: suspend (Range<T>) -> Step): Step {
    var current: Step = Step.Continue(ranges.first().high)
    for (range in ranges) {
        if (current != Step.Continue(range.high)) break
        current = step(range)
    }
    return current
}

/** Base64 writes every started group of three bytes as four characters. */
private fun base64Length(bytes: Int): Int = (bytes + BASE64_GROUP_BYTES - 1) / BASE64_GROUP_BYTES * BASE64_GROUP_CHARS

/** The messages in groups whose base64 fits one upload, in their order. */
private fun uploadGroups(messages: List<MailHistoryMessage>): List<List<MailHistoryMessage>> {
    val groups = mutableListOf<MutableList<MailHistoryMessage>>()
    var size = 0
    for (message in messages) {
        val cost = base64Length(message.fetch.size) + UPLOAD_MESSAGE_OVERHEAD
        if (groups.isEmpty() || size + cost > UPLOAD_BASE64_BUDGET) {
            groups += mutableListOf<MailHistoryMessage>()
            size = 0
        }
        groups.last() += message
        size += cost
    }
    return groups
}

/**
 * The lease of one call of [IndexMailHistory] on the server: its token, the folders it leased so far, renewal, and
 * the counters it reports.
 */
private class HistoryLease(
    val mailboxId: String,
    val token: String,
    private val history: MailHistoryRepository,
    private val timeSource: TimeSource,
    private val progress: (MailHistoryProgress) -> Unit,
) {
    /** Leased folders not started yet, in the order the server listed them. */
    private val pending = LinkedHashMap<String, MailHistoryFolder>()
    private val leased = mutableSetOf<String>()
    private var foldersDone = 0
    private var uploaded = 0
    private var lastClaim: TimeMark = timeSource.markNow()

    /** Claims again with the token; `null` when the claim failed. */
    suspend fun claimAgain(): MailHistoryClaim? =
        (history.claim(mailboxId, token) as? RepositoryResult.Content)?.value?.also {
            lastClaim = timeSource.markNow()
            add(it)
        }

    /** Queues the folders [claim] leased that this run has not seen, and refreshes those not started yet. */
    fun add(claim: MailHistoryClaim) {
        for (folder in claim.folders) {
            if (leased.add(folder.folderId) || folder.folderId in pending) pending[folder.folderId] = folder
        }
        report()
    }

    fun takeNext(): MailHistoryFolder? = pending.values.firstOrNull()?.also { pending.remove(it.folderId) }

    fun folderDone() {
        foldersDone += 1
        report()
    }

    fun accepted(messages: Int) {
        uploaded += messages
        report()
    }

    /**
     * Claims again once the last claim is [RENEW_AFTER] old; `null` when it was not due or still holds [folder] at
     * [cursor]. A folder it no longer holds is finished for the device, one at another cursor goes on from there.
     */
    suspend fun renew(folder: MailHistoryFolder, cursor: Long): Step? =
        if (lastClaim.elapsedNow() < RENEW_AFTER) null else renewed(claimAgain(), folder, cursor)

    /** Ends the token's leases. One that fails expires on its own within the lease; nothing waits for it. */
    suspend fun release() {
        withContext(NonCancellable) { withTimeoutOrNull(RELEASE_TIMEOUT) { history.release(mailboxId, token) } }
    }

    private fun report() = progress(MailHistoryProgress(foldersDone, leased.size, uploaded))
}

/** What a renewing [claim] (`null`: it failed) means for the walk of [folder] at [cursor]. */
private fun renewed(claim: MailHistoryClaim?, folder: MailHistoryFolder, cursor: Long): Step? {
    val held = claim?.folders?.firstOrNull { it.folderId == folder.folderId }
    return when {
        claim == null -> Step.Stop(MailHistoryIndexEnd.SERVER_FAILED)
        held == null || held.uidvalidity != folder.uidvalidity -> Step.Finished
        held.backfillBelowUid != cursor -> continueAt(held.backfillBelowUid)
        else -> null
    }
}

/** Waits for a claim that leases a folder while the server still backfills some folder itself. */
private fun MailHistoryClaim.waitsForLease() = folders.isEmpty() && pendingFullBackfill

/** One call of [IndexMailHistory]: the folders of its [lease] walked over one IMAP connection, slice by slice. */
private class HistoryRun(
    private val lease: HistoryLease,
    private val history: MailHistoryRepository,
    private val timeSource: TimeSource,
) {
    private var staleInRow = 0

    suspend fun index(first: MailHistoryClaim, imap: MailHistoryImap, login: MailHistoryLogin): MailHistoryIndexEnd =
        awaitLease(first) ?: when (val opened = imap.open(login)) {
            is RepositoryResult.Failure -> MailHistoryIndexEnd.IMAP_FAILED
            is RepositoryResult.Content -> try {
                indexFolders(opened.value)
            } finally {
                withContext(NonCancellable) { opened.value.close() }
            }
        }

    /** Claims again until a folder is leased; `null` once one is, the run's end when none was within the wait. */
    private suspend fun awaitLease(first: MailHistoryClaim): MailHistoryIndexEnd? {
        val start = timeSource.markNow()
        var claim: MailHistoryClaim? = first
        while (claim != null && claim.waitsForLease() && start.elapsedNow() < POLL_FOR) {
            delay(POLL_EVERY)
            claim = lease.claimAgain()
        }
        return when {
            claim == null -> MailHistoryIndexEnd.SERVER_FAILED
            claim.folders.isEmpty() -> MailHistoryIndexEnd.NOTHING_LEASED
            else -> {
                lease.add(claim)
                null
            }
        }
    }

    private suspend fun indexFolders(session: MailHistoryImapSession): MailHistoryIndexEnd {
        var end: MailHistoryIndexEnd? = null
        var next = lease.takeNext()
        while (end == null && next != null) {
            end = indexFolder(session, next)
            if (end == null) lease.folderDone()
            next = lease.takeNext()
        }
        return end ?: MailHistoryIndexEnd.COMPLETE
    }

    /** Indexes one folder; `null` when the run goes on with the next one, the run's end otherwise. */
    private suspend fun indexFolder(session: MailHistoryImapSession, folder: MailHistoryFolder): MailHistoryIndexEnd? =
        when (val examined = session.examine(folder.path)) {
            is RepositoryResult.Failure -> when (examined.kind) {
                // The server's folder is not on the IMAP server under its path any more: the next one.
                FailureKind.REJECTED -> null
                else -> MailHistoryIndexEnd.IMAP_FAILED
            }
            is RepositoryResult.Content -> if (examined.value == folder.uidvalidity) walk(session, folder) else null
        }

    private suspend fun walk(session: MailHistoryImapSession, folder: MailHistoryFolder): MailHistoryIndexEnd? {
        staleInRow = 0
        var step = continueAt(folder.backfillBelowUid)
        while (step is Step.Continue) step = span(session, folder, step.cursor)
        return (step as? Step.Stop)?.end
    }

    /** One `UID SEARCH` below [cursor], its messages fetched and uploaded. */
    private suspend fun span(session: MailHistoryImapSession, folder: MailHistoryFolder, cursor: Long): Step {
        lease.renew(folder, cursor)?.let { return it }
        val low = maxOf(1L, cursor - SEARCH_SPAN)
        return when (val found = session.search(low, cursor - 1)) {
            is RepositoryResult.Failure -> Step.Stop(MailHistoryIndexEnd.IMAP_FAILED)
            is RepositoryResult.Content -> {
                val uids = found.value.filter { it in low..<cursor }.distinct().sortedDescending()
                along(ranges(uids.chunked(FETCH_UIDS), cursor, low) { it }) { fetchAndUpload(session, folder, it) }
            }
        }
    }

    private suspend fun fetchAndUpload(
        session: MailHistoryImapSession,
        folder: MailHistoryFolder,
        range: Range<Long>,
    ): Step = when (val fetched = session.fetch(range.items)) {
        is RepositoryResult.Failure -> Step.Stop(MailHistoryIndexEnd.IMAP_FAILED)
        is RepositoryResult.Content -> {
            // A UID expunged since the search has no response and is left out.
            val messages = range.items.mapNotNull { uid -> fetched.value[uid]?.let { MailHistoryMessage(uid, it) } }
            val tooLarge = messages.indexOfFirst { it.fetch.size > MAX_FETCH_BYTES }
            if (tooLarge < 0) {
                uploadAll(folder, Range(range.high, range.low, messages))
            } else {
                // The slice ends just above the message, and the server's backfill takes the folder on from there.
                val above = Range(range.high, messages[tooLarge].uid + 1, messages.take(tooLarge))
                val step = if (above.low < above.high) uploadAll(folder, above) else Step.Continue(above.low)
                if (step is Step.Continue) Step.Finished else step
            }
        }
    }

    private suspend fun uploadAll(folder: MailHistoryFolder, range: Range<MailHistoryMessage>): Step =
        along(ranges(uploadGroups(range.items), range.high, range.low) { it.uid }) { upload(folder, it) }

    private suspend fun upload(folder: MailHistoryFolder, range: Range<MailHistoryMessage>): Step {
        lease.renew(folder, range.high)?.let { return it }
        val slice =
            MailHistorySlice(lease.token, folder.folderId, folder.uidvalidity, range.high, range.low, range.items)
        return when (val answer = history.upload(lease.mailboxId, slice)) {
            is RepositoryResult.Failure -> Step.Stop(MailHistoryIndexEnd.SERVER_FAILED)
            is RepositoryResult.Content -> when (val outcome = answer.value) {
                is MailHistoryUploadOutcome.Accepted -> {
                    staleInRow = 0
                    lease.accepted(range.items.size)
                    continueAt(outcome.backfillBelowUid)
                }
                is MailHistoryUploadOutcome.RangeStale ->
                    if (++staleInRow > MAX_STALE_IN_ROW) Step.Finished else continueAt(outcome.backfillBelowUid)
                MailHistoryUploadOutcome.UidvalidityChanged -> Step.Finished
                MailHistoryUploadOutcome.LeaseExpired -> Step.Stop(MailHistoryIndexEnd.LEASE_LOST)
                MailHistoryUploadOutcome.Unavailable -> Step.Stop(MailHistoryIndexEnd.UNAVAILABLE)
            }
        }
    }
}
