package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/**
 * Asks the server to sync the calendars of every internet account that has Calendars switched on, at most once per
 * [interval]: pulling the calendars list and the app coming to the front both ask, and they often come together.
 *
 * It is a nudge whose outcome nobody waits for. What the sync brings arrives through the sync socket, and what goes
 * wrong is the account's calendar status, which the server keeps. So a refused request for one account does not stop
 * the others, and a server without the sync route ([FailureKind.NOT_FOUND]) is the same as one that synced. Only when
 * the accounts could not be read is the next request let through at once.
 *
 * Called on the main thread, as the ViewModels do, so the time of the last request needs no lock.
 */
class SyncAccountCalendars(
    private val accounts: InternetAccountRepository,
    private val timeSource: TimeSource = TimeSource.Monotonic,
    private val interval: Duration = 60.seconds,
) {
    private var lastAsked: TimeMark? = null

    suspend operator fun invoke() {
        val last = lastAsked
        if (last != null && last.elapsedNow() < interval) return
        lastAsked = timeSource.markNow()
        when (val read = accounts.accounts()) {
            is RepositoryResult.Failure -> lastAsked = null
            is RepositoryResult.Content ->
                read.value.filter { it.calendarsEnabled }.forEach { accounts.syncCalendars(it.mailbox.id) }
        }
    }
}
