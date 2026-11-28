package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SleepUseCasesTest {
    private val weekdays = samplePlan("a", setOf(1, 2, 3, 4, 5))
    private val weekend = samplePlan("b", setOf(6, 7), position = 1)
    private val night = CalendarDay(2026, 10, 16)

    private fun overview(vararg plans: SleepPlan) = SleepOverview(sampleSettings(), plans.toList(), null)

    @Test fun `loading orders the plans`() = runTest {
        val repository = RecordingSleepRepository(RepositoryResult.Content(overview(weekend, weekdays)))
        val result = LoadSleep(repository)(night)
        assertEquals(RepositoryResult.Content(overview(weekdays, weekend)), result)
        assertEquals(listOf("overview:2026-10-16"), repository.calls)
    }

    @Test fun `loading passes a failure on`() = runTest {
        val repository = RecordingSleepRepository(RepositoryResult.Failure(FailureKind.UNAUTHORIZED))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), LoadSleep(repository)(null))
    }

    @Test fun `repeated or blank plan ids are invalid data`() = runTest {
        val invalid = RepositoryResult.Failure(FailureKind.INVALID_DATA)
        val repeated = RecordingSleepRepository(RepositoryResult.Content(overview(weekdays, weekdays)))
        assertEquals(invalid, LoadSleep(repeated)(null))
        val blank = RecordingSleepRepository(RepositoryResult.Content(overview(samplePlan(" ", setOf(1)))))
        assertEquals(invalid, LoadSleep(blank)(null))
    }

    @Test fun `settings accept only the offered goals and leads`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepSettings(repository)
        val rejected = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(rejected, edit(sampleSettings(), SleepSettingsChange(goalMinutes = 400)))
        assertEquals(rejected, edit(sampleSettings(), SleepSettingsChange(prepReminderMinutes = 20)))
        assertTrue(repository.calls.isEmpty())
        assertEquals(RepositoryResult.Content(Unit), edit(sampleSettings(), SleepSettingsChange(goalMinutes = 450)))
        assertEquals(
            RepositoryResult.Content(Unit),
            edit(sampleSettings(), SleepSettingsChange(alarmSound = SleepSound.PIANO)),
        )
        assertEquals(2, repository.calls.size)
    }

    private fun draft(
        days: Set<Int> = setOf(1, 2, 3),
        bed: Int = 23 * 60,
        wake: Int = 6 * 60 + 45,
        alarm: Boolean = true,
    ) = SleepScheduleDraft(days, SleepTimes(bed, wake), alarm)

    private val rejected = RepositoryResult.Failure(FailureKind.REJECTED)

    @Test fun `saving an existing plan updates it in one write`() = runTest {
        val repository = RecordingSleepRepository()
        val result = EditSleepPlans(repository).save(listOf(weekdays, weekend), "a", "unused", draft())
        assertEquals(RepositoryResult.Content(Unit), result)
        val change = SleepPlanChange(wakeDays = setOf(1, 2, 3), bed = time("23:00"), wake = time("06:45"), alarm = true)
        assertEquals(listOf("update:a:$change"), repository.calls)
    }

    @Test fun `saving a new plan creates it after the last plan under the given name`() = runTest {
        val repository = RecordingSleepRepository()
        val result = EditSleepPlans(repository).save(listOf(weekdays, weekend), null, "Other days", draft(setOf(6)))
        assertEquals(RepositoryResult.Content(Unit), result)
        val plan = NewSleepPlan("Other days", setOf(6), time("23:00"), time("06:45"), alarm = true, position = 2)
        assertEquals(listOf("create:$plan"), repository.calls)
    }

    @Test fun `saving a plan refuses what cannot be written and writes nothing`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        val plans = listOf(weekdays, weekend)
        listOf(
            "no day" to draft(days = emptySet()),
            "a day that is no weekday" to draft(days = setOf(8)),
            "a day of week zero" to draft(days = setOf(0, 1)),
            "the end of the day as a time" to draft(bed = 24 * 60, wake = 6 * 60),
            "minutes past the day" to draft(wake = 25 * 60),
            "negative minutes" to draft(bed = -5),
            "a night shorter than an hour" to draft(bed = 23 * 60, wake = 23 * 60 + 30),
            "a night longer than twelve hours" to draft(bed = 20 * 60, wake = 10 * 60),
        ).forEach { (name, draft) ->
            assertEquals(rejected, edit.save(plans, "a", "Name", draft), name)
            assertEquals(rejected, edit.save(plans, null, "Name", draft), name)
        }
        assertEquals(rejected, edit.save(plans, null, " ", draft()), "a new plan without a name")
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `saving a plan no plan has is not found`() = runTest {
        val repository = RecordingSleepRepository()
        val result = EditSleepPlans(repository).save(listOf(weekdays), "zz", "Name", draft())
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), result)
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `a refused write is the answer of saving`() = runTest {
        val repository = RecordingSleepRepository(writeAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val edit = EditSleepPlans(repository)
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), edit.save(listOf(weekdays), "a", "N", draft()))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), edit.save(listOf(weekdays), null, "N", draft()))
    }

    @Test fun `only a plan that is not the last one is deleted`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        assertEquals(rejected, edit.delete(listOf(weekdays), "a"))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), edit.delete(listOf(weekdays, weekend), "zz"))
        assertEquals(RepositoryResult.Content(Unit), edit.delete(listOf(weekdays, weekend), "b"))
        assertEquals(listOf("delete:b"), repository.calls)
    }

    @Test fun `a night change needs something to change and valid times`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepNight(repository)
        assertEquals(rejected, edit(night, SleepNightChange()))
        assertEquals(rejected, edit(night, SleepNightChange(wake = time("24:00"))))
        assertEquals(rejected, edit(night, SleepNightChange(bed = time("23:00"), wake = time("23:30"))))
        assertEquals(rejected, edit(night, SleepNightChange(bed = time("18:00"), wake = time("11:00"))))
        assertTrue(repository.calls.isEmpty())
        edit(night, SleepNightChange(bed = time("22:00")))
        edit(night, SleepNightChange(alarm = false))
        edit(night, SleepNightChange(reset = true))
        edit(night, SleepNightChange(bed = time("23:00"), wake = time("07:00")))
        assertEquals(4, repository.calls.size)
    }

    @Test fun `a night change with both times needs a night of an allowed length`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepNight(repository)
        assertEquals(rejected, edit(night, SleepNightChange(bed = time("23:00"), wake = time("23:30"))))
        assertEquals(rejected, edit(night, SleepNightChange(bed = time("20:00"), wake = time("10:00"))))
        assertTrue(repository.calls.isEmpty())
        assertEquals(
            RepositoryResult.Content(null),
            edit(night, SleepNightChange(bed = time("23:00"), wake = time("07:00"))),
        )
        assertEquals(1, repository.calls.size)
    }

    @Test fun `committing a night writes both times and the alarm`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepNight(repository)
        edit.commit(night, SleepTimes(22 * 60, 6 * 60), alarm = false)
        val change = SleepNightChange(bed = time("22:00"), wake = time("06:00"), alarm = false)
        assertEquals(listOf("night:$night:$change"), repository.calls)
    }

    @Test fun `committing a night refuses minutes that are no start time and a bad length`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepNight(repository)
        assertEquals(rejected, edit.commit(night, SleepTimes(-1, 6 * 60), alarm = true))
        assertEquals(rejected, edit.commit(night, SleepTimes(23 * 60, 24 * 60), alarm = true))
        assertEquals(rejected, edit.commit(night, SleepTimes(23 * 60, 1500), alarm = true))
        assertEquals(rejected, edit.commit(night, SleepTimes(23 * 60, 23 * 60 + 30), alarm = true))
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `a settings change replaces only the fields it names`() {
        val change = SleepSettingsChange(goalMinutes = 450, alarmSound = SleepSound.BIRDS)
        val applied = change.applyTo(sampleSettings())
        assertEquals(450, applied.goalMinutes)
        assertEquals(SleepSound.BIRDS, applied.alarmSound)
        assertEquals(sampleSettings().copy(goalMinutes = 450, alarmSound = SleepSound.BIRDS), applied)
    }
}
