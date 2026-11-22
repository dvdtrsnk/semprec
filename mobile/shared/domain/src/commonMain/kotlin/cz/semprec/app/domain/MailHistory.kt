package cz.semprec.app.domain

/**
 * The sign-in the device reads an IMAP mailbox's history with: implicit TLS to [host] on port 993 as [username]. It
 * lives in memory only while the history is indexed and is never stored; [toString] leaves the password out.
 */
class MailHistoryLogin(val host: String, val username: String, val password: String) {
    override fun toString(): String = "MailHistoryLogin(host=$host, username=$username)"

    companion object {
        /** The iCloud IMAP server, the one the server connects iCloud mailboxes to (`mailCredentialVerification.ts`). */
        private const val ICLOUD_IMAP_HOST = "imap.mail.me.com"

        /**
         * The login of a mailbox connected with [account]: the address is the user name, as the server stores it when
         * the connect names none, and the IMAP server is iCloud's or the one typed, as the server normalizes it.
         */
        fun of(account: MailPasswordAccount): MailHistoryLogin? {
            val host = when (account.provider) {
                MailPasswordProvider.ICLOUD -> ICLOUD_IMAP_HOST
                MailPasswordProvider.GENERIC -> account.imapHost?.trim()?.lowercase()?.removeSuffix(".")
            }
            return host?.takeIf { it.isNotEmpty() }?.let { MailHistoryLogin(it, account.address, account.password) }
        }
    }
}

/** A folder whose history the claim leased to the device: its server [path], and the cursor below which it is due. */
data class MailHistoryFolder(val folderId: String, val path: String, val uidvalidity: Long, val backfillBelowUid: Long)

/**
 * What a claim answered: [folders] are leased under [leaseToken]; [pendingFullBackfill] is `true` while the server
 * still backfills some folder itself, so a later claim may lease more.
 */
data class MailHistoryClaim(
    val leaseToken: String,
    val folders: List<MailHistoryFolder>,
    val pendingFullBackfill: Boolean,
)

/** One message of a slice: its UID and its untagged FETCH response, byte for byte as the IMAP server sent it. */
class MailHistoryMessage(val uid: Long, val fetch: ByteArray)

/**
 * One contiguous slice of a folder's history, `[rangeLow, rangeHigh)`, with a message for every UID the IMAP server
 * holds in it; [rangeHigh] is the folder's cursor on the server.
 */
class MailHistorySlice(
    val leaseToken: String,
    val folderId: String,
    val uidvalidity: Long,
    val rangeHigh: Long,
    val rangeLow: Long,
    val messages: List<MailHistoryMessage>,
)

/** How the server took a slice. */
sealed interface MailHistoryUploadOutcome {
    /** Written; the folder's cursor is [backfillBelowUid], `null` when its history is complete. */
    data class Accepted(val backfillBelowUid: Long?) : MailHistoryUploadOutcome

    /** The folder's cursor is elsewhere, at [backfillBelowUid] (`null`: complete); nothing was written. */
    data class RangeStale(val backfillBelowUid: Long?) : MailHistoryUploadOutcome

    /** The folder's UIDVALIDITY changed on the server; nothing was written. */
    data object UidvalidityChanged : MailHistoryUploadOutcome

    /** The lease ended; nothing was written. */
    data object LeaseExpired : MailHistoryUploadOutcome

    /** The mailbox takes no history now (not IMAP, Mail off, its sign-in refused). */
    data object Unavailable : MailHistoryUploadOutcome
}

/** The history upload routes of the server, `/api/mail/mailboxes/:id/history-index*`. */
interface MailHistoryRepository {
    /** Leases what can be leased under [leaseToken], or a new token when `null`, and renews what it holds. */
    suspend fun claim(mailboxId: String, leaseToken: String?): RepositoryResult<MailHistoryClaim>

    suspend fun upload(mailboxId: String, slice: MailHistorySlice): RepositoryResult<MailHistoryUploadOutcome>

    suspend fun release(mailboxId: String, leaseToken: String): RepositoryResult<Unit>
}

/**
 * The IMAP server of a mailbox, read-only. A failure is [cz.semprec.app.core.FailureKind.UNAUTHORIZED] for a refused
 * sign-in, `REJECTED` for a command the server refused (a folder it does not have), `INVALID_DATA` for an answer
 * that breaks the protocol and `UNAVAILABLE` for a connection that failed, timed out or whose TLS failed.
 */
interface MailHistoryImap {
    /** Opens one connection signed in with [login]; the caller closes it. */
    suspend fun open(login: MailHistoryLogin): RepositoryResult<MailHistoryImapSession>
}

/** One signed-in IMAP connection. */
interface MailHistoryImapSession {
    /** Opens [path] read-only and answers its UIDVALIDITY. */
    suspend fun examine(path: String): RepositoryResult<Long>

    /** The UIDs of the open folder in `[low, high]`. */
    suspend fun search(low: Long, high: Long): RepositoryResult<List<Long>>

    /** The untagged FETCH response of each of [uids] the folder still holds, by UID. */
    suspend fun fetch(uids: List<Long>): RepositoryResult<Map<Long, ByteArray>>

    /** Logs out and closes the connection; never fails. */
    suspend fun close()
}
