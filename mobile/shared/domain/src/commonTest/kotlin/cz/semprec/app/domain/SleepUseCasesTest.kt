package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
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

    @Test fun `switching a day writes only the edited plan`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        edit.toggleDay(listOf(weekdays, weekend), "a", 6)
        assertEquals(
            listOf("update:a:${SleepPlanChange(wakeDays = setOf(1, 2, 3, 4, 5, 6))}"),
            repository.calls,
        )
    }

    @Test fun `an unknown plan or day is not found`() = runTest {
        val edit = EditSleepPlans(RecordingSleepRepository())
        val missing = RepositoryResult.Failure(FailureKind.NOT_FOUND)
        assertEquals(missing, edit.toggleDay(listOf(weekdays), "zz", 1))
        assertEquals(missing, edit.toggleDay(listOf(weekdays), "a", 9))
    }

    @Test fun `plan times refuse the end of day`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        val rejected = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(rejected, edit.setBed("a", time("24:00")))
        assertEquals(rejected, edit.setWake("a", time("24:00")))
        assertTrue(repository.calls.isEmpty())
        edit.setBed("a", time("22:30"))
        edit.setWake("a", time("07:00"))
        edit.setAlarm("a", false)
        assertEquals(3, repository.calls.size)
    }

    @Test fun `adding a plan needs a free day and a name`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edit.add(listOf(weekdays, weekend), "Other"))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edit.add(listOf(weekdays), " "))
        assertEquals(RepositoryResult.Content("new-plan"), edit.add(listOf(weekdays), "Other"))
        assertEquals(1, repository.calls.size)
    }

    @Test fun `saving a new schedule creates it after the last plan with every field`() = runTest {
        val repository = RecordingSleepRepository()
        val plans =
            listOf(samplePlan("p1", setOf(1, 2, 3, 4, 5), position = 0), samplePlan("p2", setOf(6), position = 3))
        val schedule = SleepSchedule(setOf(6, 7), time("23:30"), time("08:00"), alarm = false)

        val saved = EditSleepPlans(repository).save(plans, null, "Weekend", schedule)

        assertEquals(RepositoryResult.Content(Unit), saved)
        val created = NewSleepPlan("Weekend", setOf(6, 7), time("23:30"), time("08:00"), alarm = false, position = 4)
        assertEquals(listOf("create:$created"), repository.calls)
    }

    @Test fun `saving an existing schedule writes all its fields to that plan`() = runTest {
        val repository = RecordingSleepRepository()
        val plans = listOf(samplePlan("p1", setOf(1, 2, 3, 4, 5)))
        val schedule = SleepSchedule(setOf(1, 2), time("22:00"), time("06:00"), alarm = true)

        assertEquals(RepositoryResult.Content(Unit), EditSleepPlans(repository).save(plans, "p1", "", schedule))

        val change = SleepPlanChange(wakeDays = setOf(1, 2), bed = time("22:00"), wake = time("06:00"), alarm = true)
        assertEquals(listOf("update:p1:$change"), repository.calls)
    }

    @Test fun `a schedule without a day with a day outside the week or at the end of day is refused`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        val plans = listOf(samplePlan("p1", setOf(1)))
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)

        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(emptySet(), time("23:00"), time("07:00"), true)))
        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(setOf(8), time("23:00"), time("07:00"), true)))
        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("24:00"), time("07:00"), true)))
        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("23:00"), time("24:00"), true)))
        assertEquals(emptyList(), repository.calls)
    }

    @Test fun `a schedule shorter than the shortest night or longer than the longest is refused`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        val plans = listOf(samplePlan("p1", setOf(1)))
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        val saved = RepositoryResult.Content(Unit)

        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("06:00"), time("06:30"), true)))
        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("19:00"), time("07:05"), true)))
        assertEquals(refused, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("08:00"), time("07:00"), true)))
        assertEquals(emptyList(), repository.calls)
        assertEquals(saved, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("23:00"), time("00:00"), true)))
        assertEquals(saved, edit.save(plans, "p1", "", SleepSchedule(setOf(1), time("19:00"), time("07:00"), true)))
        assertEquals(2, repository.calls.size)
    }

    @Test fun `saving an unknown plan is not found and a new one without a name is refused`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        val schedule = SleepSchedule(setOf(1), time("23:00"), time("07:00"), alarm = true)

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), edit.save(emptyList(), "gone", "", schedule))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edit.save(emptyList(), null, " ", schedule))
        assertEquals(emptyList(), repository.calls)
    }

    @Test fun `only a plan that is not the last one is deleted`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepPlans(repository)
        val rejected = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(rejected, edit.delete(listOf(weekdays), "a"))
        assertEquals(rejected, edit.delete(listOf(weekdays, weekend), "zz"))
        assertEquals(RepositoryResult.Content(Unit), edit.delete(listOf(weekdays, weekend), "b"))
        assertEquals(listOf("delete:b"), repository.calls)
    }

    @Test fun `a night change needs something to change and valid times`() = runTest {
        val repository = RecordingSleepRepository()
        val edit = EditSleepNight(repository)
        val rejected = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(rejected, edit(night, SleepNightChange()))
        assertEquals(rejected, edit(night, SleepNightChange(wake = time("24:00"))))
        assertTrue(repository.calls.isEmpty())
        edit(night, SleepNightChange(bed = time("22:00")))
        edit(night, SleepNightChange(alarm = false))
        edit(night, SleepNightChange(reset = true))
        assertEquals(3, repository.calls.size)
    }

    @Test fun `a settings change replaces only the fields it names`() {
        val change = SleepSettingsChange(goalMinutes = 450, alarmSound = SleepSound.BIRDS)
        val applied = change.applyTo(sampleSettings())
        assertEquals(450, applied.goalMinutes)
        assertEquals(SleepSound.BIRDS, applied.alarmSound)
        assertEquals(sampleSettings().copy(goalMinutes = 450, alarmSound = SleepSound.BIRDS), applied)
    }
}
