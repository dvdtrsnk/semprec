package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class MailAccountPhase { LOADING, CONTENT, ERROR }

/** Where the removal of the account is: not asked, reading what it would hide, waiting for the answer, running. */
enum class MailRemovalPhase { IDLE, LOADING_IMPACT, CONFIRMING, REMOVING }

/** What removing the account hides, so that the confirmation can name it. */
data class MailRemovalImpactItem(val messages: Int, val drafts: Int, val threads: Int, val attachmentsKept: Int)

/** One mailbox. [connectionLimitApplies] is `true` for a mailbox that syncs over IMAP, where the limit matters. */
data class MailAccountDetail(
    val id: String,
    val name: String,
    val address: String?,
    val provider: String?,
    val syncMode: String,
    val status: MailAccountStatus,
    val lastSuccessfulSyncAt: String?,
    val failingSince: String?,
    val connectionLimit: Int,
    val connectionLimitApplies: Boolean,
    val autonomousSendProjectCount: Int,
)

data class MailAccountState(
    val phase: MailAccountPhase = MailAccountPhase.LOADING,
    val failure: FailureKind? = null,
    val account: MailAccountDetail? = null,
    val removal: MailRemovalPhase = MailRemovalPhase.IDLE,
    val impact: MailRemovalImpactItem? = null,
    val actionFailed: Boolean = false,
)

sealed interface MailAccountAction {
    data object Retry : MailAccountAction
    data class Rename(val name: String) : MailAccountAction

    /** Raises or lowers the number of connections the server may open; the result stays between 1 and 15. */
    data class StepConnectionLimit(val delta: Int) : MailAccountAction
    data object RequestRemoval : MailAccountAction
    data object CancelRemoval : MailAccountAction
    data object ConfirmRemoval : MailAccountAction
    data object DismissFailure : MailAccountAction
}

sealed interface MailAccountEffect {
    /** The mailbox was removed; the screen goes back. */
    data object Removed : MailAccountEffect
}
