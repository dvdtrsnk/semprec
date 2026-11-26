package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
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

private const val STEP = 5

/** The plan editor of the sleep sheet: its draft, the dial, the days and the alarm, and confirming or discarding it. */
@OptIn(ExperimentalCoroutinesApi::class)
class SleepEditorTest : MainDispatcherTest() {
    private fun sleep(repository: FakeSleepRepository, night: String? = "2026-10-16") =
        SleepViewModelFactory(repository).sleepViewModel(night, startOnNight = false)

    private fun SleepViewModel.editor(): SleepDraft = assertNotNull(state.value.editor)

    private val onlyWeekdays = sleepOverview(plans = listOf(sleepWeekdayPlan()))

    @Test fun `editing a plan opens a draft of it`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p2"))
        val expected = SleepDraft(
            planId = "p2",
            isNew = false,
            wakeDays = listOf(6, 7),
            takenDays = listOf(1, 2, 3, 4, 5),
            bedMinutes = 0,
            wakeMinutes = 8 * 60 + 30,
            durationMinutes = 510,
            goalDifferenceMinutes = 30,
            meetsGoal = true,
            alarm = false,
            canSave = false,
            canDelete = true,
            stepMinutes = STEP,
        )
        assertEquals(expected, vm.state.value.editor)
        assertNull(vm.state.value.nightDraft)
        assertEquals(SleepScreen.MAIN, vm.state.value.screen)
        vm.close()
    }

    @Test fun `a new plan starts on the free days at the times of the first plan with the alarm off`() =
        runTest(dispatcher) {
            val vm = sleep(FakeSleepRepository(sleepContent(onlyWeekdays)))
            runCurrent()
            vm.onAction(SleepAction.Draft.EditPlan(null))
            val draft = vm.editor()
            assertNull(draft.planId)
            assertTrue(draft.isNew)
            assertEquals(listOf(6, 7), draft.wakeDays)
            assertEquals(listOf(1, 2, 3, 4, 5), draft.takenDays)
            assertEquals(23 * 60 to 6 * 60 + 45, draft.bedMinutes to draft.wakeMinutes)
            assertFalse(draft.alarm)
            assertTrue(draft.canSave)
            assertFalse(draft.canDelete)
            vm.close()
        }

    @Test fun `a new plan has no day when every day is taken and cannot be saved until one is picked`() =
        runTest(dispatcher) {
            val vm = sleep(FakeSleepRepository(sleepContent()))
            runCurrent()
            vm.onAction(SleepAction.Draft.EditPlan(null))
            assertTrue(vm.editor().wakeDays.isEmpty())
            assertFalse(vm.editor().canSave)
            vm.onAction(SleepAction.Draft.ToggleDraftDay(6))
            assertEquals(listOf(6), vm.editor().wakeDays)
            assertTrue(vm.editor().canSave)
            vm.close()
        }

    @Test fun `editing a plan no plan has fails as not found and opens nothing`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("nope"))
        assertNull(vm.state.value.editor)
        assertTrue(vm.state.value.saveFailed)
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `an editor that is open stays when another plan is asked for`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.EditPlan("p2"))
        assertEquals("p1", vm.editor().planId)
        vm.close()
    }

    @Test fun `the dial moves one end or the whole night of the draft without writing`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        val steps = listOf(
            Triple(SleepDialHandle.BED, 22 * 60, 22 * 60 to 6 * 60 + 45),
            Triple(SleepDialHandle.WAKE, 7 * 60, 22 * 60 to 7 * 60),
            Triple(SleepDialHandle.WHOLE, 23 * 60 + 30, 23 * 60 + 30 to 8 * 60 + 30),
        )
        for ((handle, minutes, expected) in steps) {
            vm.onAction(SleepAction.Draft.MoveDial(handle, minutes))
            val draft = vm.editor()
            assertEquals(expected, draft.bedMinutes to draft.wakeMinutes, "$handle")
        }
        assertTrue(vm.editor().canSave)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `the draft tells the length and how it compares with the goal`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        assertEquals(465, vm.editor().durationMinutes)
        assertEquals(-15, vm.editor().goalDifferenceMinutes)
        assertFalse(vm.editor().meetsGoal)
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.WAKE, 7 * 60))
        assertEquals(480, vm.editor().durationMinutes)
        assertEquals(0, vm.editor().goalDifferenceMinutes)
        assertTrue(vm.editor().meetsGoal)
        vm.close()
    }

    @Test fun `the dial snaps wraps and keeps the night between an hour and twelve`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 25 * 60 + 2))
        assertEquals(60, vm.editor().bedMinutes)
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, -3))
        assertEquals(24 * 60 - 5, vm.editor().bedMinutes)
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 17 * 60))
        assertEquals(720, vm.editor().durationMinutes)
        assertEquals(5 * 60, vm.editor().wakeMinutes)
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 6 * 60))
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.WAKE, 6 * 60 + 30))
        assertEquals(60, vm.editor().durationMinutes)
        assertEquals(5 * 60 + 30 to 6 * 60 + 30, vm.editor().bedMinutes to vm.editor().wakeMinutes)
        vm.close()
    }

    @Test fun `days and the alarm change the draft and a day of another plan can be taken`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.ToggleDraftDay(5))
        assertEquals(listOf(1, 2, 3, 4), vm.editor().wakeDays)
        vm.onAction(SleepAction.Draft.ToggleDraftDay(6))
        assertEquals(listOf(1, 2, 3, 4, 6), vm.editor().wakeDays)
        assertEquals(listOf(6, 7), vm.editor().takenDays)
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        assertFalse(vm.editor().alarm)
        assertTrue(vm.editor().canSave)
        vm.close()
    }

    @Test fun `a number that is no weekday is refused and the draft stays`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        val before = vm.editor()
        vm.onAction(SleepAction.Draft.ToggleDraftDay(9))
        assertEquals(before, vm.editor())
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `without a draft the dial the days and the alarm do nothing`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        val before = vm.state.value
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 60))
        vm.onAction(SleepAction.Draft.ToggleDraftDay(1))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.DiscardDraft)
        assertEquals(before, vm.state.value)
        vm.close()
    }

    @Test fun `confirming writes a plan in one write closes the editor and reads the overview again`() =
        runTest(dispatcher) {
            val repository = FakeSleepRepository(sleepContent(), sleepContent())
            val vm = sleep(repository)
            runCurrent()
            vm.onAction(SleepAction.Draft.EditPlan("p2"))
            vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.WAKE, 9 * 60))
            vm.onAction(SleepAction.Draft.SetDraftAlarm(on = true))
            vm.onAction(SleepAction.Draft.ToggleDraftDay(5))
            vm.onAction(SleepAction.Draft.ConfirmDraft("ignored for an existing plan"))
            assertNull(vm.state.value.editor)
            assertTrue(vm.state.value.saving)
            runCurrent()
            assertEquals(
                listOf("plan:p2:SleepPlanChange(name=null, wakeDays=[5, 6, 7], bed=00:00, wake=09:00, alarm=true)"),
                repository.writes,
            )
            assertFalse(vm.state.value.saving)
            assertFalse(vm.state.value.saveFailed)
            assertNull(vm.state.value.editor)
            assertEquals(2, repository.overviewCalls)
            vm.close()
        }

    @Test fun `confirming a new plan creates it under the given name after the last plan`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(onlyWeekdays), sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan(null))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = true))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Other days"))
        runCurrent()
        assertEquals(listOf("create:Other days:[6, 7]"), repository.writes)
        assertNull(vm.state.value.editor)
        assertEquals(2, repository.overviewCalls)
        vm.close()
    }

    @Test fun `a refused write puts the draft back in the open editor and reports the failure`() =
        runTest(dispatcher) {
            val repository = FakeSleepRepository(
                sleepContent(),
                writeAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE),
            )
            val vm = sleep(repository)
            runCurrent()
            vm.onAction(SleepAction.Draft.EditPlan("p1"))
            vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 22 * 60))
            val draft = vm.editor()
            vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
            assertNull(vm.state.value.editor)
            runCurrent()
            assertEquals(draft, vm.state.value.editor)
            assertTrue(vm.state.value.saveFailed)
            assertEquals(FailureKind.UNAVAILABLE, vm.state.value.saveFailure)
            assertFalse(vm.state.value.saving)
            assertEquals(1, repository.overviewCalls)
            vm.close()
        }

    @Test fun `a write that crashes puts the draft back with an unexpected failure`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        val draft = vm.editor()
        repository.crash = true
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        runCurrent()
        assertEquals(draft, vm.state.value.editor)
        assertTrue(vm.state.value.saveFailed)
        assertNull(vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `a draft the rules refuse is not written and comes back`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        for (day in 1..5) vm.onAction(SleepAction.Draft.ToggleDraftDay(day))
        assertTrue(vm.editor().wakeDays.isEmpty())
        assertFalse(vm.editor().canSave)
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        runCurrent()
        assertTrue(vm.editor().wakeDays.isEmpty())
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a new plan without a name is refused`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(onlyWeekdays))
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan(null))
        vm.onAction(SleepAction.Draft.ConfirmDraft("  "))
        runCurrent()
        assertNotNull(vm.state.value.editor)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `confirming twice writes once`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        runCurrent()
        assertEquals(1, repository.writes.size)
        vm.close()
    }

    @Test fun `a draft confirmed while another write runs waits its turn and is not dropped`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM_SNOOZE, on = false))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        assertNull(vm.state.value.editor)
        assertEquals(1, repository.writes.size)
        repository.gate = null
        gate.complete(Unit)
        runCurrent()
        assertEquals(2, repository.writes.size)
        assertTrue(repository.writes[0].startsWith("settings:"))
        assertTrue(repository.writes[1].startsWith("plan:p1:"))
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `a retry drops the drafts that wait so that they never write after the reload`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM_SNOOZE, on = false))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        vm.onAction(SleepAction.Retry)
        repository.gate = null
        gate.complete(Unit)
        runCurrent()
        assertEquals(SleepPhase.READY, vm.state.value.phase)
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.MUTE_SEMP, on = false))
        runCurrent()
        assertEquals(2, repository.writes.size)
        assertTrue(repository.writes.none { it.startsWith("plan:") })
        vm.close()
    }

    @Test fun `a waiting draft that is refused comes back after the write before it`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM_SNOOZE, on = false))
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        for (day in 1..5) vm.onAction(SleepAction.Draft.ToggleDraftDay(day))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        repository.gate = null
        gate.complete(Unit)
        runCurrent()
        assertNotNull(vm.state.value.editor)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `discarding closes the editor without a write`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.DiscardDraft)
        assertNull(vm.state.value.editor)
        runCurrent()
        assertTrue(repository.writes.isEmpty())
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        assertTrue(vm.editor().alarm)
        vm.close()
    }

    @Test fun `deleting removes the plan of the editor and reads the overview again`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(), sleepContent(onlyWeekdays))
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p2"))
        vm.onAction(SleepAction.Draft.DeleteDraftPlan)
        assertNull(vm.state.value.editor)
        runCurrent()
        assertEquals(listOf("delete:p2"), repository.writes)
        assertEquals(1, vm.state.value.plans.size)
        assertNull(vm.state.value.editor)
        vm.close()
    }

    @Test fun `the last plan cannot be deleted and its editor stays`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(onlyWeekdays))
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        assertFalse(vm.editor().canDelete)
        vm.onAction(SleepAction.Draft.DeleteDraftPlan)
        runCurrent()
        assertNotNull(vm.state.value.editor)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a plan that is not saved yet has nothing to delete`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(onlyWeekdays))
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan(null))
        vm.onAction(SleepAction.Draft.DeleteDraftPlan)
        runCurrent()
        assertNotNull(vm.state.value.editor)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a refused delete brings the editor back`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(
            sleepContent(),
            writeAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE),
        )
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.EditPlan("p2"))
        val draft = vm.editor()
        vm.onAction(SleepAction.Draft.DeleteDraftPlan)
        runCurrent()
        assertEquals(draft, vm.state.value.editor)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `a refresh while the editor is open keeps the draft and updates the days of other plans`() =
        runTest(dispatcher) {
            val changed = sleepContent(
                sleepOverview(
                    plans = listOf(sleepWeekdayPlan(), sleepWeekendPlan().copy(wakeDays = setOf(6))),
                    settings = sleepSettings().copy(muteSemp = false),
                ),
            )
            val repository = FakeSleepRepository(sleepContent(), changed)
            val vm = sleep(repository)
            runCurrent()
            vm.onAction(SleepAction.Draft.EditPlan("p1"))
            vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 22 * 60))
            val draft = vm.editor()
            vm.onAction(SleepAction.SetSwitch(SleepSwitch.MUTE_SEMP, on = false))
            runCurrent()
            assertEquals(2, repository.overviewCalls)
            assertEquals(draft.copy(takenDays = listOf(6)), vm.editor())
            vm.close()
        }

    @Test fun `closing with the editor open ends it and a late write publishes nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.Draft.EditPlan("p1"))
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertTrue(vm.state.value.saving)
        assertEquals(1, repository.overviewCalls)
        vm.onAction(SleepAction.Draft.EditPlan("p2"))
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 60))
        assertNull(vm.state.value.editor)
    }
}
