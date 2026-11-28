package cz.alldots.app.presentation

import cz.alldots.app.domain.IndexMailHistory
import cz.alldots.app.domain.MailHistoryClaim
import cz.alldots.app.domain.MailHistoryFolder
import cz.alldots.app.domain.MailHistoryImap
import cz.alldots.app.domain.MailHistoryImapSession
import cz.alldots.app.domain.MailHistoryLogin
import cz.alldots.app.domain.MailHistoryRepository
import cz.alldots.app.domain.MailHistorySlice
import cz.alldots.app.domain.MailHistoryUploadOutcome
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred

/** A server that leases one folder per mailbox, `INBOX` below UID 2, and takes every slice as the last one. */
internal class ScriptedMailHistory(private val leases: Boolean = true) : MailHistoryRepository {
    val claimed = mutableListOf<String>()
    val uploaded = mutableListOf<Pair<String, MailHistorySlice>>()
    val released = mutableListOf<String>()

    /** Completed by the test before an upload is answered; already complete unless the test holds it. */
    var uploadGate = CompletableDeferred(Unit)

    override suspend fun claim(mailboxId: String, leaseToken: String?): RepositoryResult<MailHistoryClaim> {
        claimed += mailboxId
        val folders = if (leases) listOf(MailHistoryFolder("f-$mailboxId", "INBOX", 7, 2)) else emptyList()
        return RepositoryResult.Content(MailHistoryClaim("lease-$mailboxId", folders, pendingFullBackfill = false))
    }

    override suspend fun upload(
        mailboxId: String,
        slice: MailHistorySlice,
    ): RepositoryResult<MailHistoryUploadOutcome> {
        uploadGate.await()
        uploaded += mailboxId to slice
        return RepositoryResult.Content(MailHistoryUploadOutcome.Accepted(null))
    }

    override suspend fun release(mailboxId: String, leaseToken: String): RepositoryResult<Unit> {
        released += leaseToken
        return RepositoryResult.Content(Unit)
    }
}

/** An IMAP server whose folder holds UID 1; it records the logins and the open connections. */
internal class ScriptedHistoryImap : MailHistoryImap {
    val logins = mutableListOf<MailHistoryLogin>()
    var open = 0
        private set
    var mostOpen = 0
        private set

    override suspend fun open(login: MailHistoryLogin): RepositoryResult<MailHistoryImapSession> {
        logins += login
        open += 1
        mostOpen = maxOf(mostOpen, open)
        return RepositoryResult.Content(Session())
    }

    private inner class Session : MailHistoryImapSession {
        override suspend fun examine(path: String) = RepositoryResult.Content(7L)

        override suspend fun search(low: Long, high: Long) = RepositoryResult.Content(listOf(1L))

        override suspend fun fetch(uids: List<Long>) =
            RepositoryResult.Content(uids.associateWith { "* 1 FETCH (UID $it)\r\n".encodeToByteArray() })

        override suspend fun close() {
            open -= 1
        }
    }
}

internal fun indexHistory(
    history: ScriptedMailHistory = ScriptedMailHistory(leases = false),
    imap: ScriptedHistoryImap = ScriptedHistoryImap(),
) = IndexMailHistory(history, imap)
