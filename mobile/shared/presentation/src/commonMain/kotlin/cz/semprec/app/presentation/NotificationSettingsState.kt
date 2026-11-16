package cz.semprec.app.presentation

import cz.semprec.app.core.AccountNotificationSwitch
import cz.semprec.app.core.AccountProblemsLevel
import cz.semprec.app.core.FailureKind

enum class NotificationSettingsPhase { LOADING, CONTENT, ERROR }

/** What the person asked to be notified about; each switch is on or off, the problem level has three steps. */
data class NotificationChoices(
    val approvals: Boolean,
    val invites: Boolean,
    val reminders: Boolean,
    val problemsLevel: AccountProblemsLevel,
    val problemsSummary: Boolean,
    val badgeApprovals: Boolean,
    val badgeInvites: Boolean,
    val badgeInbox: Boolean,
)

/** The notification settings; [writeFailure] is the last change the server refused, which was taken back. */
data class NotificationSettingsState(
    val phase: NotificationSettingsPhase = NotificationSettingsPhase.LOADING,
    val failure: FailureKind? = null,
    val choices: NotificationChoices? = null,
    val writeFailure: Failed? = null,
)

sealed interface NotificationSettingsAction {
    data object Retry : NotificationSettingsAction

    data class Set(val switch: AccountNotificationSwitch, val on: Boolean) : NotificationSettingsAction

    data class SetProblemsLevel(val level: AccountProblemsLevel) : NotificationSettingsAction

    data object DismissFailure : NotificationSettingsAction
}
