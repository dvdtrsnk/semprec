package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

fun time(text: String): ClockTime = requireNotNull(ClockTime.parse(text))

fun samplePlan(
    id: String,
    days: Set<Int>,
    position: Int = 0,
    bed: String = "23:00",
    wake: String = "06:45",
    alarm: Boolean = true,
) = SleepPlan(id, "Plan $id", days, time(bed), time(wake), alarm, position)

fun sampleSettings() = SleepSettings(
    itemId = "settings",
    enabled = true,
    showInCalendar = true,
    muteSemp = true,
    alarmSound = SleepSound.MORNING,
    alarmSnooze = true,
    goalMinutes = 480,
    prepReminder = true,
    prepReminderMinutes = 30,
)

/** A repository that records its calls and answers [overview] and the writes with what the test sets. */
class RecordingSleepRepository(
    var overviewResult: RepositoryResult<SleepOverview> = RepositoryResult.Failure(FailureKind.UNAVAILABLE),
) : SleepRepository {
    val calls = mutableListOf<String>()

    override suspend fun overview(night: CalendarDay?): RepositoryResult<SleepOverview> {
        calls += "overview:$night"
        return overviewResult
    }

    /** What [nights] answers. */
    var nightsResult: RepositoryResult<List<SleepNight>> = RepositoryResult.Content(emptyList())

    override suspend fun nights(from: CalendarDay, to: CalendarDay): RepositoryResult<List<SleepNight>> {
        calls += "nights:$from..$to"
        return nightsResult
    }

    override suspend fun updateSettings(itemId: String, change: SleepSettingsChange): RepositoryResult<Unit> {
        calls += "settings:$itemId:$change"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun createPlan(plan: NewSleepPlan): RepositoryResult<String> {
        calls += "create:$plan"
        return RepositoryResult.Content("new-plan")
    }

    override suspend fun updatePlan(planId: String, change: SleepPlanChange): RepositoryResult<Unit> {
        calls += "update:$planId:$change"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun deletePlan(planId: String): RepositoryResult<Unit> {
        calls += "delete:$planId"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun changeNight(night: CalendarDay, change: SleepNightChange): RepositoryResult<SleepNight?> {
        calls += "night:$night:$change"
        return RepositoryResult.Content(null)
    }
}
