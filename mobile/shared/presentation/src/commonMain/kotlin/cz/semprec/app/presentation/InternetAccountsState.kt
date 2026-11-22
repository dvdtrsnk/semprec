package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class InternetAccountsPhase { LOADING, CONTENT, ERROR }

/**
 * What one service of an account is doing. [OFF] while its switch is off; [PENDING] when Calendars was switched on and
 * the server has not synced yet; [NEEDS_CONSENT] when an OAuth account lacks the permission for the service.
 */
enum class InternetServiceStatus { OFF, PENDING, SYNCING, OK, ERROR, NEEDS_REAUTHORIZATION, NEEDS_CONSENT }

/** A service of an internet account, switched on and off on its own. */
enum class InternetAccountService { MAIL, CALENDARS }

/**
 * A row of the accounts list; [provider] is the stored key (`gmail`, `outlook`, `icloud`, `generic`), `null` if
 * unknown. [canSignInAgain] is `true` when a service no longer accepts the account's sign-in and the app can sign it
 * in again: in a browser for Google and Microsoft, with a password for iCloud and other accounts.
 */
data class InternetAccountItem(
    val id: String,
    val name: String,
    val address: String?,
    val provider: String?,
    val mail: InternetServiceStatus,
    val calendars: InternetServiceStatus,
    val canSignInAgain: Boolean = false,
)

/** The accounts that are connected with an address and a password; Google and Microsoft sign in in a browser. */
enum class InternetPasswordProvider { ICLOUD, OTHER }

/** The accounts that sign in in a browser. */
enum class InternetOAuthProvider { GOOGLE, MICROSOFT }

/**
 * Why an account was not connected or signed in: the input is incomplete, the server [REFUSED] it for a reason it did
 * not name, it could not be reached, or, for a browser sign-in, the provider [DECLINED] it (for example because the
 * person did not allow access). A password login the server checked names its reason: the user name or password
 * ([WRONG_CREDENTIALS]), an iCloud account that needs an app-specific password ([APP_PASSWORD_REQUIRED]), a mail
 * server that could not be reached ([SERVER_UNREACHABLE]) or whose secure connection failed ([TLS_FAILED]), a CalDAV
 * server that refused the login ([CALDAV_REFUSED]) or was not found ([CALDAV_UNREACHABLE]), an address another account
 * already holds ([ALREADY_CONNECTED]), or too many attempts ([RATE_LIMITED]).
 */
enum class InternetConnectFailure {
    INVALID_INPUT,
    REFUSED,
    UNAVAILABLE,
    UNEXPECTED,
    DECLINED,
    WRONG_CREDENTIALS,
    APP_PASSWORD_REQUIRED,
    SERVER_UNREACHABLE,
    TLS_FAILED,
    CALDAV_REFUSED,
    CALDAV_UNREACHABLE,
    ALREADY_CONNECTED,
    RATE_LIMITED,
}

/**
 * Signing a password account in again: [accountId] with its [address], [icloud] for an iCloud account (which needs an
 * app-specific password). [submitting] is `true` while the server checks the login, and [failure] says why the last
 * attempt did not succeed.
 */
data class InternetPasswordSignIn(
    val accountId: String,
    val address: String?,
    val icloud: Boolean,
    val submitting: Boolean = false,
    val failure: InternetConnectFailure? = null,
)

/** A step of [InternetPasswordSignIn]. */
sealed interface InternetPasswordSignInStep {
    /** Sends [password] and [username]; a blank [username] keeps the user name the server has. */
    data class Submit(val password: String, val username: String) : InternetPasswordSignInStep

    /** Closes the sign-in; ignored while the server checks the login. */
    data object Cancel : InternetPasswordSignInStep
}

/**
 * The older mail history the device indexes for the account [accountId] it connected, while the password typed is in
 * memory: [foldersTotal] folders the server leased to the device so far, [foldersDone] of them finished, and
 * [messagesUploaded] messages the server took. [foldersTotal] is 0 while the server has not leased a folder yet.
 */
data class InternetHistoryIndexing(
    val accountId: String,
    val foldersDone: Int,
    val foldersTotal: Int,
    val messagesUploaded: Int,
)

/**
 * [connecting] is `true` while an account is being connected, a browser sign-in included, from its start until the
 * browser came back and the server answered. [existingAccountId] is the listed account that already holds the address
 * of a connect refused as [InternetConnectFailure.ALREADY_CONNECTED]. [signingIn] is `true` while a listed account
 * signs in again in a browser, and [signInFailure] says why the last one did not succeed; [passwordSignIn] is the
 * password sign-in of a listed account, while it is open. [historyIndexing] is the history indexing of an account
 * connected with a password, while it runs.
 */
data class InternetAccountsState(
    val phase: InternetAccountsPhase = InternetAccountsPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val accounts: List<InternetAccountItem> = emptyList(),
    val connecting: Boolean = false,
    val connectFailure: InternetConnectFailure? = null,
    val existingAccountId: String? = null,
    val signingIn: Boolean = false,
    val signInFailure: InternetConnectFailure? = null,
    val passwordSignIn: InternetPasswordSignIn? = null,
    val historyIndexing: InternetHistoryIndexing? = null,
)

sealed interface InternetAccountsAction {
    data object Retry : InternetAccountsAction
    data object Refresh : InternetAccountsAction
    data class Open(val accountId: String) : InternetAccountsAction

    /**
     * Connects an account with its address and password. The servers are for [InternetPasswordProvider.OTHER] only,
     * where the IMAP and SMTP servers are required and the CalDAV server may be left empty.
     */
    data class Connect(
        val provider: InternetPasswordProvider,
        val address: String,
        val password: String,
        val imapHost: String,
        val smtpHost: String,
        val caldavUrl: String,
    ) : InternetAccountsAction
    /** Dismisses [InternetAccountsState.connectFailure] and [InternetAccountsState.existingAccountId]. */
    data object DismissConnectFailure : InternetAccountsAction

    /** Opens [InternetAccountsState.existingAccountId]. */
    data object OpenExisting : InternetAccountsAction

    /**
     * Signs a listed account in again while [InternetAccountItem.canSignInAgain]: a Google or Microsoft account in a
     * browser ([InternetAccountsEffect.OpenSignIn], reported back with [SignIn]), another account with a password
     * ([InternetAccountsState.passwordSignIn], continued with [PasswordSignIn]).
     */
    data class SignInAgain(val accountId: String) : InternetAccountsAction
    data class PasswordSignIn(val step: InternetPasswordSignInStep) : InternetAccountsAction

    /** Dismisses [InternetAccountsState.signInFailure]. */
    data object DismissSignInFailure : InternetAccountsAction

    /**
     * The browser sign-in of a new account, or of a listed one signing in again ([SignInAgain]);
     * [InternetAccountsEffect.OpenSignIn] says how the app reports back.
     */
    sealed interface SignIn : InternetAccountsAction {
        /** Starts it for an account that syncs mail and, when [calendars], its calendars. */
        data class Start(val provider: InternetOAuthProvider, val calendars: Boolean) : SignIn
        data class Returned(val callbackUrl: String) : SignIn
        data object Cancelled : SignIn
        data object Failed : SignIn
    }
}

sealed interface InternetAccountsEffect {
    data class OpenAccount(val accountId: String) : InternetAccountsEffect

    /** A new account was connected and the list shows it; the form closes. */
    data object Connected : InternetAccountsEffect

    /**
     * Opens [url], the provider's sign-in page, in a browser session that ends at `semprec://oauth`. The app reports
     * how it ended with `SignIn.Returned`, `SignIn.Cancelled` or `SignIn.Failed`.
     */
    data class OpenSignIn(val url: String) : InternetAccountsEffect
}
