package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepPlanChange
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SleepViewModelTest : MainDispatcherTest() {
    private fun sleep(
        repository: FakeSleepRepository,
        night: String? = "2026-10-16",
        startOnNight: Boolean = false,
    ) = SleepViewModelFactory(repository).sleepViewModel(night, startOnNight)

    @Test fun `starts loading and then shows the settings plans night and ring`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        assertEquals(SleepPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(SleepPhase.READY, state.phase)
        assertEquals(SleepScreen.MAIN, state.screen)
        assertTrue(state.isRoot)
        assertEquals(listOf("p1", "p2"), state.plans.map { it.id })
        assertEquals(listOf(1, 2, 3, 4, 5), state.plans.first().wakeDays)
        assertEquals(465, state.plans.first().durationMinutes)
        assertEquals(480, state.goalMinutes)
        assertEquals(listOf(420, 450, 480, 510, 540), state.goalOptions)
        assertEquals(60, state.shortestNightMinutes)
        assertEquals(720, state.longestNightMinutes)
        assertEquals(listOf(15, 30, 45, 60), state.reminderLeadOptions)
        assertEquals(SleepAlarmSound.MORNING, state.alarmSound)
        assertEquals(SleepRing(23 * 60, 6 * 60 + 45, 465, -15, alarm = true), state.ring)
        assertEquals(22 * 60 + 30, state.night?.reminderMinutes)
        assertFalse(state.canAddPlan)
        assertTrue(state.canDeletePlan)
        vm.close()
    }

    @Test fun `the reminder time is absent while the reminder is off`() = runTest(dispatcher) {
        val off = sleepSettings().copy(prepReminder = false)
        val vm = sleep(FakeSleepRepository(sleepContent(sleepOverview(settings = off))))
        runCurrent()
        assertNull(vm.state.value.night?.reminderMinutes)
        vm.close()
    }

    @Test fun `a load failure keeps its reason and retry loads again`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepUnavailable(), sleepContent())
        val vm = sleep(repository)
        runCurrent()
        assertEquals(SleepPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        vm.onAction(SleepAction.Retry)
        assertEquals(SleepPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(SleepPhase.READY, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        assertEquals(2, repository.overviewCalls)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a reason`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent(), crash = true))
        runCurrent()
        assertEquals(SleepPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a load that answers after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val vm = sleep(FakeSleepRepository(sleepContent(), gate = gate))
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(SleepPhase.LOADING, vm.state.value.phase)
        assertTrue(vm.state.value.plans.isEmpty())
    }

    @Test fun `an older load that answers late does not replace a newer one`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository =
            FakeSleepRepository(sleepContent(sleepOverview(plans = listOf(sleepWeekdayPlan()))), gate = gate)
        val vm = sleep(repository)
        runCurrent()
        repository.gate = null
        vm.onAction(SleepAction.Retry)
        runCurrent()
        assertEquals(SleepPhase.READY, vm.state.value.phase)
        gate.complete(Unit)
        runCurrent()
        assertEquals(SleepPhase.READY, vm.state.value.phase)
        assertEquals(1, vm.state.value.plans.size)
        vm.close()
    }

    @Test fun `opening a plan shows its ring and back returns to the overview`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p2"))
        val state = vm.state.value
        assertEquals(SleepScreen.PLAN, state.screen)
        assertFalse(state.isRoot)
        assertEquals("p2", state.selectedPlanId)
        assertEquals(510, state.ring?.durationMinutes)
        assertEquals(listOf(1, 2, 3, 4, 5), state.takenDaysByOtherPlans)
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertNull(vm.state.value.selectedPlanId)
        vm.close()
    }

    @Test fun `an unknown plan is not opened and back at the root does nothing`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "nope"))
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.close()
    }

    @Test fun `opening on the night makes it the root and the overview a step in`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()), startOnNight = true)
        runCurrent()
        assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
        assertTrue(vm.state.value.isRoot)
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
        vm.onAction(SleepAction.Open(SleepScreen.MAIN))
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertFalse(vm.state.value.isRoot)
        vm.onAction(SleepAction.Open(SleepScreen.GOAL))
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
        vm.close()
    }

    @Test fun `a night start without a valid night opens the overview`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()), night = "garbage", startOnNight = true)
        runCurrent()
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertTrue(vm.state.value.isRoot)
        vm.onAction(SleepAction.Open(SleepScreen.NIGHT))
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.close()
    }

    @Test fun `a switch shows at once is written and the overview is read again`() = runTest(dispatcher) {
        val after = sleepContent(sleepOverview(settings = sleepSettings().copy(showInCalendar = false)))
        val repository = FakeSleepRepository(sleepContent(), after)
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.SHOW_IN_CALENDAR, on = false))
        assertFalse(vm.state.value.showInCalendar)
        assertTrue(vm.state.value.saving)
        runCurrent()
        assertFalse(vm.state.value.saving)
        assertFalse(vm.state.value.showInCalendar)
        assertTrue(repository.writes.single().contains("showInCalendar=false"))
        assertEquals(2, repository.overviewCalls)
        vm.close()
    }

    @Test fun `a refused settings write is reverted and reported`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(
            sleepContent(),
            writeAnswer = RepositoryResult.Failure(FailureKind.REJECTED),
        )
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ENABLED, on = false))
        assertFalse(vm.state.value.enabled)
        runCurrent()
        assertTrue(vm.state.value.enabled)
        assertTrue(vm.state.value.saveFailed)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertFalse(vm.state.value.saving)
        assertEquals(1, repository.overviewCalls)
        vm.onAction(SleepAction.DismissSaveFailure)
        assertFalse(vm.state.value.saveFailed)
        assertNull(vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `a write that crashes is an unexpected save failure`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.crash = true
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.MUTE_SEMP, on = false))
        runCurrent()
        assertTrue(vm.state.value.saveFailed)
        assertNull(vm.state.value.saveFailure)
        assertTrue(vm.state.value.muteSemp)
        vm.close()
    }

    @Test fun `changes made while one is written are ignored`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM_SNOOZE, on = false))
        runCurrent()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.PREP_REMINDER, on = false))
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p1"))
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, repository.writes.size)
        vm.close()
    }

    @Test fun `picking a goal goes back to the overview and writes it`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.GOAL))
        assertEquals(SleepScreen.GOAL, vm.state.value.screen)
        vm.onAction(SleepAction.PickMinutes(SleepMinutesChoice.GOAL, 450))
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertEquals(450, vm.state.value.goalMinutes)
        runCurrent()
        assertTrue(repository.writes.single().contains("goalMinutes=450"))
        vm.close()
    }

    @Test fun `a goal the settings do not accept is refused and reverted`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.PickMinutes(SleepMinutesChoice.GOAL, 400))
        runCurrent()
        assertEquals(480, vm.state.value.goalMinutes)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `picking a sound and a lead writes them`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.PickSound(SleepAlarmSound.PIANO))
        runCurrent()
        vm.onAction(SleepAction.PickMinutes(SleepMinutesChoice.REMINDER_LEAD, 45))
        runCurrent()
        assertTrue(repository.writes[0].contains("alarmSound=PIANO"))
        assertTrue(repository.writes[1].contains("prepReminderMinutes=45"))
        vm.close()
    }

    @Test fun `switching a day writes only the open plan and does nothing elsewhere`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.ToggleDay(6))
        runCurrent()
        assertTrue(repository.writes.isEmpty())
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p1"))
        vm.onAction(SleepAction.ToggleDay(6))
        runCurrent()
        assertTrue(repository.writes.single().startsWith("plan:p1:"))
        assertTrue(repository.writes.single().contains("wakeDays=[1, 2, 3, 4, 5, 6]"))
        vm.close()
    }

    @Test fun `times and the alarm of an open plan are written to that plan`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p2"))
        vm.onAction(SleepAction.SetTime(SleepTimeField.BED, 22 * 60))
        runCurrent()
        vm.onAction(SleepAction.SetTime(SleepTimeField.WAKE, 7 * 60 + 15))
        runCurrent()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM, on = true))
        runCurrent()
        assertTrue(repository.writes[0].contains("p2") && repository.writes[0].contains("bed=22:00"))
        assertTrue(repository.writes[1].contains("wake=07:15"))
        assertTrue(repository.writes[2].contains("alarm=true"))
        vm.close()
    }

    @Test fun `a time outside the day is ignored`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SetTime(SleepTimeField.BED, 24 * 60))
        vm.onAction(SleepAction.SetTime(SleepTimeField.BED, -1))
        runCurrent()
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `on the overview a time edits the plan of the shown night`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SetTime(SleepTimeField.WAKE, 6 * 60))
        runCurrent()
        assertTrue(repository.writes.single().startsWith("plan:p1:"))
        vm.close()
    }

    @Test fun `without a shown night the overview edits the first plan`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(sleepOverview(night = null)))
        val vm = sleep(repository, night = null)
        runCurrent()
        vm.onAction(SleepAction.SetTime(SleepTimeField.WAKE, 6 * 60))
        runCurrent()
        assertTrue(repository.writes.single().startsWith("plan:p1:"))
        assertNull(vm.state.value.night)
        vm.close()
    }

    @Test fun `the night view writes the night and can reset it`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository, startOnNight = true)
        runCurrent()
        vm.onAction(SleepAction.SetTime(SleepTimeField.BED, 22 * 60 + 30))
        runCurrent()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM, on = false))
        runCurrent()
        vm.onAction(SleepAction.ResetNight)
        runCurrent()
        assertTrue(repository.writes[0].startsWith("night:2026-10-16:") && repository.writes[0].contains("bed=22:30"))
        assertTrue(repository.writes[1].contains("alarm=false"))
        assertTrue(repository.writes[2].contains("reset=true"))
        vm.close()
    }

    @Test fun `a night without a plan shows the base ring`() = runTest(dispatcher) {
        val bare = sleepOverview(plans = emptyList(), night = null)
        val vm = sleep(FakeSleepRepository(sleepContent(bare)), startOnNight = true)
        runCurrent()
        val ring = assertNotNull(vm.state.value.ring)
        assertEquals(SleepRing(23 * 60, 7 * 60, 480, 0, alarm = false), ring)
        assertTrue(vm.state.value.canAddPlan)
        assertFalse(vm.state.value.canDeletePlan)
        vm.close()
    }

    @Test fun `a plan is added for the free days and opened`() = runTest(dispatcher) {
        val onlyWeekdays = sleepContent(sleepOverview(plans = listOf(sleepWeekdayPlan())))
        val withNew = sleepContent(
            sleepOverview(plans = listOf(sleepWeekdayPlan(), sleepWeekendPlan().copy(id = "p-new"))),
        )
        val repository = FakeSleepRepository(onlyWeekdays, withNew)
        val vm = sleep(repository)
        runCurrent()
        assertTrue(vm.state.value.canAddPlan)
        vm.onAction(SleepAction.AddPlan("Other days"))
        runCurrent()
        assertEquals("create:Other days:[6, 7]", repository.writes.single())
        assertEquals(SleepScreen.PLAN, vm.state.value.screen)
        assertEquals("p-new", vm.state.value.selectedPlanId)
        vm.close()
    }

    @Test fun `no plan is added without a free day`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.AddPlan("Other days"))
        runCurrent()
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `deleting the open plan returns to the overview and the last plan stays`() = runTest(dispatcher) {
        val afterDelete = sleepContent(sleepOverview(plans = listOf(sleepWeekdayPlan())))
        val repository = FakeSleepRepository(sleepContent(), afterDelete)
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p2"))
        vm.onAction(SleepAction.DeletePlan)
        runCurrent()
        assertEquals("delete:p2", repository.writes.single())
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertEquals(1, vm.state.value.plans.size)
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p1"))
        vm.onAction(SleepAction.DeletePlan)
        runCurrent()
        assertEquals(1, repository.writes.size)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `saving a new schedule creates it with its days times and alarm in one write`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p1"))
        assertEquals(SleepScreen.PLAN, vm.state.value.screen)
        vm.onAction(SleepAction.SavePlan(null, "Weekend", listOf(6, 7), 23 * 60 + 45, 7 * 60 + 15, alarm = false))
        runCurrent()
        assertEquals("create:Weekend:[6, 7]", repository.writes.single())
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertNull(vm.state.value.selectedPlanId)
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `saving an existing schedule writes all its fields to that plan`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SavePlan("p2", "ignored", listOf(5, 6, 7), 22 * 60, 6 * 60, alarm = true))
        runCurrent()
        val expected = SleepPlanChange(
            wakeDays = setOf(5, 6, 7),
            bed = ClockTime(22 * 60),
            wake = ClockTime(6 * 60),
            alarm = true,
        )
        assertEquals("plan:p2:$expected", repository.writes.single())
        vm.close()
    }

    @Test fun `a schedule without days outside the week or at the end of day is refused`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SavePlan("p1", "x", emptyList(), 23 * 60, 7 * 60, alarm = true))
        runCurrent()
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        vm.onAction(SleepAction.DismissSaveFailure)
        vm.onAction(SleepAction.SavePlan("p1", "x", listOf(8), 23 * 60, 7 * 60, alarm = true))
        runCurrent()
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        vm.onAction(SleepAction.DismissSaveFailure)
        vm.onAction(SleepAction.SavePlan("p1", "x", listOf(1), 23 * 60, 24 * 60, alarm = true))
        runCurrent()
        // A time outside the day is ignored like one sent with SetTime: no write and no failure shown.
        assertNull(vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `saving an unknown plan or a new one without a name is refused`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SavePlan("gone", "x", listOf(1), 23 * 60, 7 * 60, alarm = true))
        runCurrent()
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.saveFailure)
        vm.onAction(SleepAction.DismissSaveFailure)
        vm.onAction(SleepAction.SavePlan(null, " ", listOf(1), 23 * 60, 7 * 60, alarm = true))
        runCurrent()
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a refused schedule write is reported`() = runTest(dispatcher) {
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        val repository = FakeSleepRepository(sleepContent(), writeAnswer = refused)
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p1"))
        vm.onAction(SleepAction.SavePlan(null, "New", listOf(6), 23 * 60, 7 * 60, alarm = false))
        runCurrent()
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertEquals(1, repository.writes.size)
        // A refused write keeps the editor open.
        assertEquals(SleepScreen.PLAN, vm.state.value.screen)
        vm.close()
    }

    @Test fun `removing a plan from the editor deletes it unless it is the last`() = runTest(dispatcher) {
        val afterDelete = sleepContent(sleepOverview(plans = listOf(sleepWeekdayPlan())))
        val repository = FakeSleepRepository(sleepContent(), afterDelete)
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p2"))
        assertEquals(SleepScreen.PLAN, vm.state.value.screen)
        vm.onAction(SleepAction.RemovePlan("p2"))
        runCurrent()
        assertEquals("delete:p2", repository.writes.single())
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.onAction(SleepAction.RemovePlan("p1"))
        runCurrent()
        assertEquals(1, repository.writes.size)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `saving the night writes its times and alarm in one change`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository, startOnNight = true)
        runCurrent()
        vm.onAction(SleepAction.SaveNight(23 * 60 + 30, 7 * 60, alarm = false))
        runCurrent()
        val expected = SleepNightChange(bed = ClockTime(23 * 60 + 30), wake = ClockTime(7 * 60), alarm = false)
        assertEquals("night:2026-10-16:$expected", repository.writes.single())
        assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
        vm.close()
    }

    @Test fun `saving the night does nothing outside the night view or out of the day`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.SaveNight(23 * 60, 7 * 60, alarm = true))
        vm.onAction(SleepAction.Open(SleepScreen.NIGHT))
        vm.onAction(SleepAction.SaveNight(24 * 60, 7 * 60, alarm = true))
        runCurrent()
        assertNull(vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a plan that vanished after a write closes its view`() = runTest(dispatcher) {
        val gone = sleepContent(sleepOverview(plans = listOf(sleepWeekdayPlan())))
        val repository = FakeSleepRepository(sleepContent(), gone)
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Open(SleepScreen.PLAN, "p2"))
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM, on = true))
        runCurrent()
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertNull(vm.state.value.selectedPlanId)
        vm.close()
    }

    @Test fun `a closed model ignores actions`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.close()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ENABLED, on = false))
        vm.onAction(SleepAction.Retry)
        runCurrent()
        assertEquals(SleepPhase.READY, vm.state.value.phase)
        assertTrue(repository.writes.isEmpty())
        assertEquals(1, repository.overviewCalls)
    }

    @Test fun `clearing the store ends the model like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { sleep(FakeSleepRepository(sleepContent())) }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
    }

    @Test fun `closing while a write is in flight publishes nothing more`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.SHOW_IN_CALENDAR, on = false))
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertTrue(vm.state.value.saving)
        assertEquals(1, repository.overviewCalls)
    }
}
