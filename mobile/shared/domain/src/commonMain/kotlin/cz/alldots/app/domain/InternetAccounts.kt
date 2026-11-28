package cz.alldots.app.domain

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

/** A provider whose accounts sign in in a browser. */
enum class OAuthProvider { GOOGLE, MICROSOFT }

/**
 * A browser sign-in the server has started: the browser opens [authorizeUrl], and the provider's answer comes back
 * to the app carrying [state].
 */
data class OAuthSignIn(val authorizeUrl: String, val state: String)

/**
 * How a browser sign-in ended: the account [Connected] (new or signed in again), the provider [Declined] it, or the
 * server [Refused] the account that signed in, naming why.
 */
sealed interface OAuthOutcome {
    data class Connected(val accountId: String) : OAuthOutcome

    /** The provider sent back an error instead of a code, for example because the person did not allow access. */
    data object Declined : OAuthOutcome

    /**
     * The server refused the signed-in account: another mailbox already holds it ([MailConnectRefusal.ALREADY_CONNECTED])
     * it is not the account being signed in again ([MailConnectRefusal.WRONG_ACCOUNT]), or the sign-in did not allow
     * access to its mail ([MailConnectRefusal.MAIL_CONSENT_MISSING]).
     */
    data class Refused(val reason: MailConnectRefusal) : OAuthOutcome
}

/**
 * The internet accounts of the signed-in person and their service switches. A rename, a removal and a password
 * connect are the mailbox's own ([MailboxRepository]). Google and Microsoft accounts sign in in a browser:
 * [startSignIn] or [startReauthorization] gives the page to open, and [finishSignIn] hands the server what the
 * browser returned. Nothing is saved before [finishSignIn] succeeds.
 */
interface InternetAccountRepository {
    suspend fun accounts(): RepositoryResult<List<InternetAccount>>

    suspend fun account(accountId: String): RepositoryResult<InternetAccount>

    suspend fun setServiceEnabled(accountId: String, service: InternetService, enabled: Boolean): RepositoryResult<Unit>

    /** Asks the server to sync the account's calendars now. */
    suspend fun syncCalendars(accountId: String): RepositoryResult<Unit>

    /** Starts the sign-in of a new account that syncs [services]; [InternetService.MAIL] is always among them. */
    suspend fun startSignIn(provider: OAuthProvider, services: Set<InternetService>): RepositoryResult<OAuthSignIn>

    /**
     * Starts signing an existing account in again. The server asks for the services switched on for it together with
     * [services], so an empty set renews what it has.
     */
    suspend fun startReauthorization(accountId: String, services: Set<InternetService>): RepositoryResult<OAuthSignIn>

    /**
     * Finishes [signIn] with [callbackUrl], the `alldots://oauth` address the browser returned to. An address that is
     * not that, or that carries another state than [signIn]'s, is [cz.alldots.app.core.FailureKind.INVALID_DATA] and
     * sends nothing.
     */
    suspend fun finishSignIn(signIn: OAuthSignIn, callbackUrl: String): RepositoryResult<OAuthOutcome>
}
