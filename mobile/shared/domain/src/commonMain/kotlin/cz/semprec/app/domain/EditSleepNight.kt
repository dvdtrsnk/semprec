package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Changes the exception of one night, or sets it back to follow the plan. */
class EditSleepNight(private val repository: SleepRepository) {
    /**
     * Writes [change]. A change with nothing to write, a time that is not a start time of the day, or both times with
     * a night of a length the settings do not allow is a refusal. A change of one time only cannot be checked for its
     * length here, because the other time is the plan's.
     */
    suspend operator fun invoke(night: CalendarDay, change: SleepNightChange): RepositoryResult<SleepNight?> {
        val times = listOfNotNull(change.bed, change.wake)
        val empty = !change.reset && times.isEmpty() && change.alarm == null
        val bed = change.bed
        val wake = change.wake
        val badLength = bed != null && wake != null && !SleepDial.isNightLength(SleepRules.durationMinutes(bed, wake))
        return when {
            empty || !times.all(SleepRules::isSleepTime) || badLength ->
                RepositoryResult.Failure(FailureKind.REJECTED)
            else -> repository.changeNight(night, change)
        }
    }

    /** Writes the night as it is on the dial: both times and the alarm. Minutes that are no clock time are a refusal. */
    suspend fun commit(night: CalendarDay, times: SleepTimes, alarm: Boolean): RepositoryResult<SleepNight?> {
        val clock = times.toClockTimes() ?: return RepositoryResult.Failure(FailureKind.REJECTED)
        return invoke(night, SleepNightChange(bed = clock.first, wake = clock.second, alarm = alarm))
    }
}
