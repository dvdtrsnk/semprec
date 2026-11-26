package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Changes the exception of one night, or sets it back to follow the plan. */
class EditSleepNight(private val repository: SleepRepository) {
    suspend operator fun invoke(night: CalendarDay, change: SleepNightChange): RepositoryResult<SleepNight?> {
        val times = listOfNotNull(change.bed, change.wake)
        val empty = !change.reset && times.isEmpty() && change.alarm == null
        val bed = change.bed
        val wake = change.wake
        val badLength = bed != null && wake != null && !SleepNightRules.isNightLength(bed, wake)
        return when {
            empty || badLength || !times.all(SleepRules::isSleepTime) -> RepositoryResult.Failure(FailureKind.REJECTED)
            else -> repository.changeNight(night, change)
        }
    }
}
