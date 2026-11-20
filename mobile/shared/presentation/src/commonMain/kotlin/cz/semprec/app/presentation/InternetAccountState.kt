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
 * matters.
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
)

/**
 * [confirmingOff] is the service whose switching off waits for the person's answer, because it removes what the
 * service synced. [syncRequested] is `true` while the request to sync the calendars now is under way.
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
    data object DismissFailure : InternetAccountAction
}

sealed interface InternetAccountEffect {
    /** The account was removed; the screen goes back. */
    data object Removed : InternetAccountEffect

    /** Calendars was switched on; the app asks for the permission to notify about calendar changes. */
    data object CalendarsTurnedOn : InternetAccountEffect
}
