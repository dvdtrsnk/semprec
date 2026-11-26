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

/** The night view of the sleep sheet: the dial edits a draft of the night, which is written when it is committed. */
@OptIn(ExperimentalCoroutinesApi::class)
class SleepNightDraftTest : MainDispatcherTest() {
    private fun sleep(repository: FakeSleepRepository, startOnNight: Boolean = true) =
        SleepViewModelFactory(repository).sleepViewModel("2026-10-16", startOnNight)

    private fun SleepViewModel.draft(): SleepDraft = assertNotNull(state.value.nightDraft)

    @Test fun `the night view starts a draft of the night as the server resolves it`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()))
        runCurrent()
        val expected = SleepDraft(
            planId = null,
            isNew = false,
            wakeDays = emptyList(),
            takenDays = emptyList(),
            bedMinutes = 23 * 60,
            wakeMinutes = 6 * 60 + 45,
            durationMinutes = 465,
            goalDifferenceMinutes = -15,
            meetsGoal = false,
            alarm = true,
            canSave = false,
            canDelete = false,
            stepMinutes = 5,
        )
        assertEquals(expected, vm.state.value.nightDraft)
        assertNull(vm.state.value.editor)
        vm.close()
    }

    @Test fun `a night the server does not resolve starts from the first plan and then from the base night`() =
        runTest(dispatcher) {
            val noNight = sleepOverview(night = null)
            val withPlans = sleep(FakeSleepRepository(sleepContent(noNight)))
            runCurrent()
            assertEquals(23 * 60 to 6 * 60 + 45, withPlans.draft().bedMinutes to withPlans.draft().wakeMinutes)
            assertTrue(withPlans.draft().alarm)
            withPlans.close()

            val bare = sleep(FakeSleepRepository(sleepContent(sleepOverview(plans = emptyList(), night = null))))
            runCurrent()
            assertEquals(23 * 60 to 7 * 60, bare.draft().bedMinutes to bare.draft().wakeMinutes)
            assertFalse(bare.draft().alarm)
            assertEquals(480, bare.draft().durationMinutes)
            bare.close()
        }

    @Test fun `there is no night draft off the night view`() = runTest(dispatcher) {
        val vm = sleep(FakeSleepRepository(sleepContent()), startOnNight = false)
        runCurrent()
        assertNull(vm.state.value.nightDraft)
        vm.close()
    }

    @Test fun `the dial and the alarm change the night draft and nothing is written until it is committed`() =
        runTest(dispatcher) {
            val repository = FakeSleepRepository(sleepContent())
            val vm = sleep(repository)
            runCurrent()
            vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 22 * 60 + 30))
            vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
            val draft = vm.draft()
            assertEquals(22 * 60 + 30 to 6 * 60 + 45, draft.bedMinutes to draft.wakeMinutes)
            assertFalse(draft.alarm)
            assertTrue(draft.canSave)
            assertTrue(repository.writes.isEmpty())
            vm.close()
        }

    @Test fun `committing writes both times and the alarm of the night once`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent(), sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 22 * 60 + 30))
        vm.onAction(SleepAction.Draft.CommitNight)
        assertTrue(vm.state.value.saving)
        runCurrent()
        assertEquals(1, repository.writes.size)
        assertTrue(repository.writes.single().startsWith("night:2026-10-16:"))
        assertTrue(repository.writes.single().contains("bed=22:30"))
        assertTrue(repository.writes.single().contains("wake=06:45"))
        assertTrue(repository.writes.single().contains("alarm=true"))
        assertFalse(vm.state.value.saving)
        assertFalse(vm.draft().canSave)
        assertEquals(22 * 60 + 30, vm.draft().bedMinutes)
        assertEquals(2, repository.overviewCalls)
        vm.close()
    }

    @Test fun `committing an unchanged night writes nothing`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.CommitNight)
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 22 * 60))
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 23 * 60))
        vm.onAction(SleepAction.Draft.CommitNight)
        runCurrent()
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a refused commit keeps the draft and reports the failure`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(
            sleepContent(),
            writeAnswer = RepositoryResult.Failure(FailureKind.REJECTED),
        )
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        val draft = vm.draft()
        vm.onAction(SleepAction.Draft.CommitNight)
        runCurrent()
        assertEquals(draft, vm.draft())
        assertTrue(vm.draft().canSave)
        assertEquals(FailureKind.REJECTED, vm.state.value.saveFailure)
        assertEquals(1, repository.overviewCalls)
        vm.close()
    }

    @Test fun `a refresh never replaces the night draft that is being moved`() = runTest(dispatcher) {
        val resolved = sleepFridayNight(changed = true).copy(bed = sleepClock("21:00"), durationMinutes = 585)
        val changed = sleepContent(sleepOverview(night = resolved))
        val repository = FakeSleepRepository(sleepContent(), changed)
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.WAKE, 8 * 60))
        val draft = vm.draft()
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.MUTE_SEMP, on = false))
        runCurrent()
        assertEquals(2, repository.overviewCalls)
        assertEquals(draft, vm.draft())
        assertEquals(21 * 60, vm.state.value.night?.bedMinutes)
        vm.close()
    }

    @Test fun `a commit asked for while another write runs waits its turn`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        repository.gate = gate
        vm.onAction(SleepAction.SetSwitch(SleepSwitch.ALARM_SNOOZE, on = false))
        runCurrent()
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.onAction(SleepAction.Draft.CommitNight)
        assertEquals(1, repository.writes.size)
        repository.gate = null
        gate.complete(Unit)
        runCurrent()
        assertEquals(2, repository.writes.size)
        assertTrue(repository.writes[1].startsWith("night:"))
        vm.close()
    }

    @Test fun `resetting the night writes the reset and shows the night the server resolves again`() =
        runTest(dispatcher) {
            val plan = sleepFridayNight(changed = false)
            val repository = FakeSleepRepository(
                sleepContent(sleepOverview(night = plan.copy(bed = sleepClock("22:00"), changed = true))),
                sleepContent(sleepOverview(night = plan)),
            )
            val vm = sleep(repository)
            runCurrent()
            assertEquals(22 * 60, vm.draft().bedMinutes)
            vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 21 * 60))
            vm.onAction(SleepAction.ResetNight)
            runCurrent()
            assertTrue(repository.writes.single().contains("reset=true"))
            assertEquals(23 * 60, vm.draft().bedMinutes)
            assertFalse(vm.draft().canSave)
            vm.close()
        }

    @Test fun `leaving the night view drops the draft and coming back starts a new one`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.MoveDial(SleepDialHandle.BED, 21 * 60))
        vm.onAction(SleepAction.Open(SleepScreen.MAIN))
        assertNull(vm.state.value.nightDraft)
        vm.onAction(SleepAction.Back)
        assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
        assertEquals(23 * 60, vm.draft().bedMinutes)
        assertTrue(repository.writes.isEmpty())
        vm.close()
    }

    @Test fun `a night without a day to switch ignores days and a plan editor is not touched by the night`() =
        runTest(dispatcher) {
            val vm = sleep(FakeSleepRepository(sleepContent()))
            runCurrent()
            val before = vm.state.value
            vm.onAction(SleepAction.Draft.ToggleDraftDay(3))
            vm.onAction(SleepAction.Draft.DeleteDraftPlan)
            vm.onAction(SleepAction.Draft.ConfirmDraft("Name"))
            assertEquals(before, vm.state.value)
            vm.close()
        }

    @Test fun `committing after close writes nothing`() = runTest(dispatcher) {
        val repository = FakeSleepRepository(sleepContent())
        val vm = sleep(repository)
        runCurrent()
        vm.onAction(SleepAction.Draft.SetDraftAlarm(on = false))
        vm.close()
        vm.onAction(SleepAction.Draft.CommitNight)
        runCurrent()
        assertTrue(repository.writes.isEmpty())
    }
}
