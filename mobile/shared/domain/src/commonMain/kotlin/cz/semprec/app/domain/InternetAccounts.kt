package cz.semprec.app.domain

/** A service an internet account can sync, each switched on and off on its own. */
enum class InternetService { MAIL, CALENDARS }

/**
 * Where the calendar sync of an account is. [OFF] while Calendars is switched off, [PENDING] when it is on and the
 * first sync has not reported yet, [NEEDS_CONSENT] when an OAuth account lacks the calendar permission.
 */
enum class CalendarSyncStatus { OFF, PENDING, NEEDS_CONSENT, OK, ERROR, NEVER, NEEDS_REAUTHORIZATION }

/** A provider login (a Mailboxes item) with the services it syncs; [mailbox] holds its mail side. */
data class InternetAccount(
    val mailbox: MailAccount,
    val mailEnabled: Boolean,
    val calendarsEnabled: Boolean,
    val calendarStatus: CalendarSyncStatus,
)

/**
 * The internet accounts of the signed-in person and their service switches. A rename, a removal and a password
 * connect are the mailbox's own ([MailboxRepository]).
 */
interface InternetAccountRepository {
    suspend fun accounts(): RepositoryResult<List<InternetAccount>>

    suspend fun account(accountId: String): RepositoryResult<InternetAccount>

    suspend fun setServiceEnabled(accountId: String, service: InternetService, enabled: Boolean): RepositoryResult<Unit>

    /** Asks the server to sync the account's calendars now. */
    suspend fun syncCalendars(accountId: String): RepositoryResult<Unit>
}
