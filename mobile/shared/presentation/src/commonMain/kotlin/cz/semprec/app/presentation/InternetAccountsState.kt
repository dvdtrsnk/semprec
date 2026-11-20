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

/** A row of the accounts list; [provider] is the stored key (`gmail`, `outlook`, `icloud`, `imap`), `null` if unknown. */
data class InternetAccountItem(
    val id: String,
    val name: String,
    val address: String?,
    val provider: String?,
    val mail: InternetServiceStatus,
    val calendars: InternetServiceStatus,
)

/** The accounts that are connected with an address and a password; Google and Microsoft sign in in a browser. */
enum class InternetPasswordProvider { ICLOUD, OTHER }

/** The accounts that sign in in a browser. */
enum class InternetOAuthProvider { GOOGLE, MICROSOFT }

/**
 * Why an account was not connected or signed in: the input is incomplete, the server refused it, it could not be
 * reached, or, for a browser sign-in, the provider [DECLINED] it (for example because the person did not allow access).
 */
enum class InternetConnectFailure { INVALID_INPUT, REFUSED, UNAVAILABLE, UNEXPECTED, DECLINED }

/**
 * [connecting] is `true` while an account is being connected, a browser sign-in included, from its start until the
 * browser came back and the server answered.
 */
data class InternetAccountsState(
    val phase: InternetAccountsPhase = InternetAccountsPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val accounts: List<InternetAccountItem> = emptyList(),
    val connecting: Boolean = false,
    val connectFailure: InternetConnectFailure? = null,
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
    data object DismissConnectFailure : InternetAccountsAction

    /** The browser sign-in of a new account; [InternetAccountsEffect.OpenSignIn] says how the app reports back. */
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

    /** An account was connected and the list shows it; the form closes. */
    data object Connected : InternetAccountsEffect

    /**
     * Opens [url], the provider's sign-in page, in a browser session that ends at `semprec://oauth`. The app reports
     * how it ended with `SignIn.Returned`, `SignIn.Cancelled` or `SignIn.Failed`.
     */
    data class OpenSignIn(val url: String) : InternetAccountsEffect
}
