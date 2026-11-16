package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.NewSleepPlan
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepOverview
import cz.semprec.app.domain.SleepPlan
import cz.semprec.app.domain.SleepPlanChange
import cz.semprec.app.domain.SleepRepository
import cz.semprec.app.domain.SleepSettings
import cz.semprec.app.domain.SleepSettingsChange
import cz.semprec.app.domain.SleepSound
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

fun sleepClock(text: String): ClockTime = requireNotNull(ClockTime.parse(text))

val sleepNightDay = CalendarDay(2026, 10, 16)

fun sleepWeekdayPlan() =
    SleepPlan("p1", "Weekdays", setOf(1, 2, 3, 4, 5), sleepClock("23:00"), sleepClock("06:45"), true, 0)

fun sleepWeekendPlan() = SleepPlan("p2", "Weekend", setOf(6, 7), sleepClock("00:00"), sleepClock("08:30"), false, 1)

fun sleepSettings() = SleepSettings("set1", true, true, true, SleepSound.MORNING, true, 480, true, 30)

fun sleepFridayNight(changed: Boolean = false) =
    SleepNight(sleepNightDay, "p1", "Weekdays", sleepClock("23:00"), sleepClock("06:45"), true, changed, 465)

fun sleepOverview(
    plans: List<SleepPlan> = listOf(sleepWeekdayPlan(), sleepWeekendPlan()),
    night: SleepNight? = sleepFridayNight(),
    settings: SleepSettings = sleepSettings(),
) = SleepOverview(settings, plans, night)

/**
 * A scripted sleep repository. Each [overview] call takes the next answer, then repeats the last one; writes answer
 * [writeAnswer] and are recorded in [writes]. When [gate] is set, every call waits for it even after the caller was
 * cancelled, which models a data layer that answers late.
 */
class FakeSleepRepository(
    vararg answers: RepositoryResult<SleepOverview>,
    var writeAnswer: RepositoryResult<Unit> = RepositoryResult.Content(Unit),
    var gate: CompletableDeferred<Unit>? = null,
    var crash: Boolean = false,
) : SleepRepository {
    private val script = answers.toList()
    var overviewCalls = 0
        private set
    val writes = mutableListOf<String>()

    private suspend fun waitForGate() {
        gate?.let { withContext(NonCancellable) { it.await() } }
        if (crash) error("unexpected")
    }

    override suspend fun overview(night: CalendarDay?): RepositoryResult<SleepOverview> {
        val answer = script[minOf(overviewCalls, script.lastIndex)]
        overviewCalls += 1
        waitForGate()
        return answer
    }

    override suspend fun updateSettings(itemId: String, change: SleepSettingsChange): RepositoryResult<Unit> {
        writes += "settings:$change"
        waitForGate()
        return writeAnswer
    }

    override suspend fun createPlan(plan: NewSleepPlan): RepositoryResult<String> {
        writes += "create:${plan.name}:${plan.wakeDays}"
        waitForGate()
        return when (val answer = writeAnswer) {
            is RepositoryResult.Content -> RepositoryResult.Content("p-new")
            is RepositoryResult.Failure -> answer
        }
    }

    override suspend fun updatePlan(planId: String, change: SleepPlanChange): RepositoryResult<Unit> {
        writes += "plan:$planId:$change"
        waitForGate()
        return writeAnswer
    }

    override suspend fun deletePlan(planId: String): RepositoryResult<Unit> {
        writes += "delete:$planId"
        waitForGate()
        return writeAnswer
    }

    override suspend fun changeNight(night: CalendarDay, change: SleepNightChange): RepositoryResult<SleepNight?> {
        writes += "night:$night:$change"
        waitForGate()
        return when (val answer = writeAnswer) {
            is RepositoryResult.Content -> RepositoryResult.Content(null)
            is RepositoryResult.Failure -> answer
        }
    }
}

fun sleepUnavailable() = RepositoryResult.Failure(FailureKind.UNAVAILABLE)

fun sleepContent(overview: SleepOverview = sleepOverview()) = RepositoryResult.Content(overview)
