package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/** Writes a change of the sleep settings, after checking that the goal and the reminder lead are values it accepts. */
class EditSleepSettings(private val repository: SleepRepository) {
    suspend operator fun invoke(settings: SleepSettings, change: SleepSettingsChange): RepositoryResult<Unit> {
        val goalOk = change.goalMinutes == null || change.goalMinutes in SleepRules.GOALS
        val leadOk = change.prepReminderMinutes == null || change.prepReminderMinutes in SleepRules.REMINDER_LEADS
        return if (goalOk && leadOk) {
            repository.updateSettings(settings.itemId, change)
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }
    }
}
