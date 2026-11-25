package cz.semprec.app.domain

/** One alarm of the sleep plan the device rings: the night it ends, the day it rings on and its time of day. */
data class SleepAlarm(val night: CalendarDay, val wakeDay: CalendarDay, val wake: ClockTime, val planName: String?)

/**
 * The alarms the device rings for the sleep plan: the nights of the evening before [today], whose alarm rings today,
 * and of the [days] evenings from [today] on, whose alarm is on, while the sleep plan is on. A night ends on the day
 * after its evening, whichever side of midnight its bedtime is. The plan off answers no alarm, so the device removes
 * the ones it holds.
 */
class LoadSleepAlarms(private val repository: SleepRepository) {
    suspend operator fun invoke(today: CalendarDay, days: Int = DEFAULT_DAYS): RepositoryResult<List<SleepAlarm>> =
        when (val overview = repository.overview(null)) {
            is RepositoryResult.Failure -> overview
            is RepositoryResult.Content ->
                if (overview.value.settings.enabled) alarms(today, days) else RepositoryResult.Content(emptyList())
        }

    private suspend fun alarms(today: CalendarDay, days: Int): RepositoryResult<List<SleepAlarm>> =
        when (val nights = repository.nights(today.plusDays(-1), today.plusDays(days - 1))) {
            is RepositoryResult.Failure -> nights
            is RepositoryResult.Content -> RepositoryResult.Content(
                nights.value
                    .filter { it.alarm }
                    .map { SleepAlarm(it.night, it.night.plusDays(1), it.wake, it.planName) },
            )
        }

    companion object {
        /** A week of alarms ahead: the device reads them again whenever the app opens or the plan changes. */
        const val DEFAULT_DAYS: Int = 7
    }
}
