package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class InternetAccountPhase { LOADING, CONTENT, ERROR }

/** Where the removal of the account is: not asked, reading what it would hide, waiting for the answer, running. */
enum class InternetAccountRemovalPhase { IDLE, LOADING_IMPACT, CONFIRMING, REMOVING }

/** What removing the account hides, so that the confirmation can name it. */
data class InternetAccountRemovalImpact(val messages: Int, val drafts: Int, val threads: Int, val attachmentsKept: Int)

/**
 * One internet account. [mailEnabled] and [calendarsEnabled] are its switches, [mail] and [calendars] what each
 * service is doing. [connectionLimitApplies] is `true` for an account whose mail syncs over IMAP, where the limit
 * matters. [signsInInBrowser] is `true` for a Google or Microsoft account, which signs in again and grants
 * permissions in a browser from the app.
 */
data class InternetAccountDetail(
    val id: String,
    val name: String,
    val address: String?,
    val provider: String?,
    val syncMode: String,
    val mailEnabled: Boolean,
    val calendarsEnabled: Boolean,
    val mail: InternetServiceStatus,
    val calendars: InternetServiceStatus,
    val lastSuccessfulSyncAt: String?,
    val failingSince: String?,
    val connectionLimit: Int,
    val connectionLimitApplies: Boolean,
    val autonomousSendProjectCount: Int,
    /** The messages downloaded so far while the first mail sync runs. */
    val syncedMessageCount: Int? = null,
    val signsInInBrowser: Boolean = false,
) {
    /** Whether the screen offers to sign in again: a browser account whose sign-in a service no longer accepts. */
    val canSignInAgain: Boolean
        get() = signsInInBrowser && InternetServiceStatus.NEEDS_REAUTHORIZATION in listOf(mail, calendars)

    /** Whether the screen offers to allow calendar access: a browser account whose calendars lack the permission. */
    val canAllowCalendarAccess: Boolean
        get() = signsInInBrowser && calendars == InternetServiceStatus.NEEDS_CONSENT
}

/**
 * [confirmingOff] is the service whose switching off waits for the person's answer, because it removes what the
 * service synced. [syncRequested] is `true` while the request to sync the calendars now is under way. [signingIn] is
 * `true` from the start of a browser sign-in until the browser came back and the server answered, and
 * [signInFailure] says why the last one did not succeed.
 */
data class InternetAccountState(
    val phase: InternetAccountPhase = InternetAccountPhase.LOADING,
    val failure: FailureKind? = null,
    val account: InternetAccountDetail? = null,
    val confirmingOff: InternetAccountService? = null,
    val syncRequested: Boolean = false,
    val removal: InternetAccountRemovalPhase = InternetAccountRemovalPhase.IDLE,
    val impact: InternetAccountRemovalImpact? = null,
    val actionFailed: Boolean = false,
    val signingIn: Boolean = false,
    val signInFailure: InternetConnectFailure? = null,
)

sealed interface InternetAccountAction {
    data object Retry : InternetAccountAction

    /** Switches a service on at once; switching one off first asks, and [ConfirmServiceOff] writes it. */
    data class SetService(val service: InternetAccountService, val enabled: Boolean) : InternetAccountAction
    data object ConfirmServiceOff : InternetAccountAction
    data object CancelServiceOff : InternetAccountAction
    data class Rename(val name: String) : InternetAccountAction

    /** Raises or lowers the number of connections the server may open; the result stays between 1 and 15. */
    data class StepConnectionLimit(val delta: Int) : InternetAccountAction

    /** Asks the server to sync the calendars now; only while Calendars is on. */
    data object SyncNow : InternetAccountAction

    /** The removal of the account: [Request] reads what it would hide, [Confirm] removes it, [Cancel] keeps it. */
    sealed interface Removal : InternetAccountAction {
        data object Request : Removal
        data object Cancel : Removal
        data object Confirm : Removal
    }

    /** Dismisses [InternetAccountState.actionFailed] and [InternetAccountState.signInFailure]. */
    data object DismissFailure : InternetAccountAction

    /**
     * Signing the account in again in a browser: [Again] while [InternetAccountDetail.canSignInAgain],
     * [AllowCalendarAccess] while [InternetAccountDetail.canAllowCalendarAccess]; [InternetAccountEffect.OpenSignIn]
     * says how the app reports back.
     */
    sealed interface SignIn : InternetAccountAction {
        data object Again : SignIn
        data object AllowCalendarAccess : SignIn
        data class Returned(val callbackUrl: String) : SignIn
        data object Cancelled : SignIn
        data object Failed : SignIn
    }
}

sealed interface InternetAccountEffect {
    /** The account was removed; the screen goes back. */
    data object Removed : InternetAccountEffect

    /** Calendars was switched on; the app asks for the permission to notify about calendar changes. */
    data object CalendarsTurnedOn : InternetAccountEffect

    /**
     * Opens [url], the provider's sign-in page, in a browser session that ends at `semprec://oauth`. The app reports
     * how it ended with `SignIn.Returned`, `SignIn.Cancelled` or `SignIn.Failed`.
     */
    data class OpenSignIn(val url: String) : InternetAccountEffect
}
