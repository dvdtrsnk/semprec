package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.AccountNotificationSwitch
import cz.alldots.app.core.AccountProblemsLevel
import cz.alldots.app.domain.AccountNotificationPrefs
import cz.alldots.app.domain.AccountNotificationRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The notification settings. A change shows at once and is taken back when the server refuses it, so the switches
 * never disagree with the server for longer than a request. Turning something on asks the app for the permission to
 * notify ([NotificationSettingsEffect.RequestPermission]); the system asks the person only the first time.
 */
class NotificationSettingsViewModel internal constructor(
    private val repository: AccountNotificationRepository,
) : ScreenViewModel<NotificationSettingsState, NotificationSettingsAction, NotificationSettingsEffect>(
    NotificationSettingsState(),
) {
    private var loadJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: NotificationSettingsAction) {
        if (isClosed) return
        when (action) {
            NotificationSettingsAction.Retry -> load()
            is NotificationSettingsAction.Set -> setSwitch(action.choice, action.on)
            is NotificationSettingsAction.SetProblemsLevel -> setLevel(action.level)
            NotificationSettingsAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { NotificationSettingsState() }
        loadJob = viewModelScope.launch {
            val result = answer { repository.load() }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done ->
                        NotificationSettingsState(NotificationSettingsPhase.CONTENT, null, result.value.toChoices())
                    is Answer.Rejected -> NotificationSettingsState(NotificationSettingsPhase.ERROR, result.kind)
                }
            }
        }
    }

    private fun setSwitch(switch: AccountNotificationSwitch, on: Boolean) {
        val before = state.value.choices ?: return
        if (before.isOn(switch) == on) return
        update { it.copy(choices = before.with(switch, on), writeFailure = null) }
        if (on) emit(NotificationSettingsEffect.RequestPermission)
        viewModelScope.launch {
            val result = answer { repository.setSwitch(switch, on) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> it.copy(choices = result.value.toChoices())
                    is Answer.Rejected ->
                        it.copy(choices = it.choices?.with(switch, !on), writeFailure = Failed(result.kind))
                }
            }
        }
    }

    private fun setLevel(level: AccountProblemsLevel) {
        val before = state.value.choices ?: return
        if (before.problemsLevel == level) return
        update { it.copy(choices = before.copy(problemsLevel = level), writeFailure = null) }
        if (before.problemsLevel == AccountProblemsLevel.OFF) emit(NotificationSettingsEffect.RequestPermission)
        viewModelScope.launch {
            val result = answer { repository.setProblemsLevel(level) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> it.copy(choices = result.value.toChoices())
                    is Answer.Rejected -> it.copy(
                        choices = it.choices?.copy(problemsLevel = before.problemsLevel),
                        writeFailure = Failed(result.kind),
                    )
                }
            }
        }
    }
}

private fun NotificationChoices.isOn(switch: AccountNotificationSwitch): Boolean = when (switch) {
    AccountNotificationSwitch.APPROVALS -> approvals
    AccountNotificationSwitch.INVITES -> invites
    AccountNotificationSwitch.REMINDERS -> reminders
    AccountNotificationSwitch.CALENDAR_CHANGES -> calendarChanges
    AccountNotificationSwitch.PROBLEMS_SUMMARY -> problemsSummary
    AccountNotificationSwitch.BADGE_APPROVALS -> badgeApprovals
    AccountNotificationSwitch.BADGE_INVITES -> badgeInvites
    AccountNotificationSwitch.BADGE_INBOX -> badgeInbox
}

private fun NotificationChoices.with(switch: AccountNotificationSwitch, on: Boolean): NotificationChoices =
    when (switch) {
        AccountNotificationSwitch.APPROVALS -> copy(approvals = on)
        AccountNotificationSwitch.INVITES -> copy(invites = on)
        AccountNotificationSwitch.REMINDERS -> copy(reminders = on)
        AccountNotificationSwitch.CALENDAR_CHANGES -> copy(calendarChanges = on)
        AccountNotificationSwitch.PROBLEMS_SUMMARY -> copy(problemsSummary = on)
        AccountNotificationSwitch.BADGE_APPROVALS -> copy(badgeApprovals = on)
        AccountNotificationSwitch.BADGE_INVITES -> copy(badgeInvites = on)
        AccountNotificationSwitch.BADGE_INBOX -> copy(badgeInbox = on)
    }

private fun AccountNotificationPrefs.toChoices() = NotificationChoices(
    approvals,
    invites,
    reminders,
    calendarChanges,
    problemsLevel,
    problemsSummary,
    badgeApprovals,
    badgeInvites,
    badgeInbox,
)
