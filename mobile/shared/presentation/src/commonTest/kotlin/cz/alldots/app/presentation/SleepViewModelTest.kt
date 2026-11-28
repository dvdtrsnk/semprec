package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SleepViewModelTest : MainDispatcherTest() {
    private fun sleep(
        repository: FakeSleepRepository,
        night: String? = "2026-10-16",
        startOnNight: Boolean = false,
    ) = SleepViewModelFactory(repository).sleepViewModel(night, startOnNight)

    @Test fun `starts loading and then shows the settings plans and night`() = runTest(dispatcher) {
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
        assertEquals(listOf(15, 30, 45, 60), state.reminderLeadOptions)
        assertEquals(SleepAlarmSound.MORNING, state.alarmSound)
        assertEquals(22 * 60 + 30, state.night?.reminderMinutes)
        assertNull(state.editor)
        assertNull(state.nightDraft)
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

    @Test fun `back at the root does nothing and a picker goes back to the overview`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.onAction(SleepAction.Open(SleepScreen.SOUND))
        assertFalse(vm.state.value.isRoot)
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        assertTrue(vm.state.value.isRoot)
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

    @Test fun `every switch of the overview writes its own setting`() = runTest(dispatcher) {
        val expected = mapOf(
            SleepSwitch.ENABLED to "enabled=false",
            SleepSwitch.SHOW_IN_CALENDAR to "showInCalendar=false",
            SleepSwitch.MUTE_SEMP to "muteSemp=false",
            SleepSwitch.ALARM_SNOOZE to "alarmSnooze=false",
            SleepSwitch.PREP_REMINDER to "prepReminder=false",
        )
        assertEquals(SleepSwitch.entries.toSet(), expected.keys)
        for ((target, field) in expected) {
            val repository = FakeSleepRepository(sleepContent())
            val vm = sleep(repository)
            runCurrent()
            vm.onAction(SleepAction.SetSwitch(target, on = false))
            runCurrent()
            assertTrue(repository.writes.single().contains(field), "$target wrote ${repository.writes}")
            vm.close()
        }
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
        vm.onAction(SleepAction.Open(SleepScreen.GOAL))
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

    @Test fun `a closed model ignores actions`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.close()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ENABLED, on = false))
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Retry)
        runCurrent()
        assertNull(vm.state.value.editor)
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
