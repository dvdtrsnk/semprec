package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Asks the server to sync the calendars of every internet account that has Calendars switched on. Every call is sent:
 * the server coalesces requests close together into one pass, so a request asked for here is never dropped. Calls
 * that come while a round of requests is under way wait for it and are then served together by one more round, so
 * the request that serves them leaves after they were made, and opening the calendar while the app comes to the front
 * sends at most two rounds.
 *
 * It is a nudge whose outcome nobody waits for. What the sync brings arrives through the sync socket, and what goes
 * wrong is the account's calendar status, which the server keeps. So a refused request for one account does not stop
 * the others, and a server without the sync route ([FailureKind.NOT_FOUND]) is the same as one that synced. A round
 * whose caller is cancelled, or whose accounts could not be read, serves nobody, so the next waiting call sends its
 * own.
 *
 * Called on the main thread, as the ViewModels do, so counting the calls needs no lock of its own.
 */
class SyncAccountCalendars(private val accounts: InternetAccountRepository) {
    private val rounds = Mutex()
    private var asked = 0L
    private var served = 0L

    suspend operator fun invoke() {
        val call = ++asked
        rounds.withLock {
            if (served >= call) return
            val upTo = asked
            when (val read = accounts.accounts()) {
                is RepositoryResult.Failure -> return
                is RepositoryResult.Content ->
                    read.value.filter { it.calendarsEnabled }.forEach { accounts.syncCalendars(it.mailbox.id) }
            }
            served = upTo
        }
    }
}
