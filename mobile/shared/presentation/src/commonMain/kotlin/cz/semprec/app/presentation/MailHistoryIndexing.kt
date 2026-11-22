package cz.semprec.app.presentation

import cz.semprec.app.domain.IndexMailHistory
import cz.semprec.app.domain.MailHistoryLogin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The history indexing of the mailboxes a screen connected, one mailbox at a time so that the device holds one IMAP
 * connection: [start] queues a mailbox with its login, and [show] hears what the running one does, `null` once none
 * runs. Everything runs in [scope] on the main thread. The logins live only in the queue and in the running call;
 * both are dropped when the queue is done or [scope] is cancelled.
 *
 * Once [scope] is cancelled (its screen closed), [show] is not called again: the run's cleanup (the release of the
 * lease and the logout, each bounded) still finishes after that, and must not change the state of a closed screen.
 */
internal class MailHistoryIndexing(
    private val scope: CoroutineScope,
    private val index: IndexMailHistory,
    private val show: (InternetHistoryIndexing?) -> Unit,
) {
    private val waiting = ArrayDeque<Pair<String, MailHistoryLogin>>()
    private var job: Job? = null

    /** Whether a login is still held: queued or in the running call. */
    val holdsLogins: Boolean get() = waiting.isNotEmpty() || job?.isActive == true

    fun start(mailboxId: String, login: MailHistoryLogin) {
        waiting.addLast(mailboxId to login)
        if (job?.isActive != true) job = scope.launch { drain() }
    }

    private suspend fun drain() {
        try {
            while (waiting.isNotEmpty()) {
                val (mailboxId, login) = waiting.removeFirst()
                publish(InternetHistoryIndexing(mailboxId, foldersDone = 0, foldersTotal = 0, messagesUploaded = 0))
                indexOne(mailboxId, login)
            }
        } finally {
            waiting.clear()
            publish(null)
        }
    }

    private fun publish(indexing: InternetHistoryIndexing?) {
        if (scope.isActive) show(indexing)
    }

    private suspend fun indexOne(mailboxId: String, login: MailHistoryLogin) {
        try {
            index(mailboxId, login) { progress ->
                publish(
                    InternetHistoryIndexing(
                        mailboxId,
                        progress.foldersDone,
                        progress.foldersTotal,
                        progress.messagesUploaded,
                    ),
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Indexing is a head start for the server, which backfills the rest itself; an unexpected failure ends
            // this mailbox's run as a refused one does, and the next queued mailbox still runs.
        }
    }
}
