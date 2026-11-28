package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempRunStatus
import cz.alldots.app.domain.SempRunStepsPage
import cz.alldots.app.domain.SempRunTrigger
import cz.alldots.app.domain.SempRunUsage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun failedTick() = sempRun(SempRunStatus.ERROR, SempRunTrigger.TICK)

@OptIn(ExperimentalCoroutinesApi::class)
class SempRunViewModelTest : MainDispatcherTest() {

    private fun run(runs: FakeSempRunRepository, messageId: String? = null) =
        sempFactory(runs = runs).runViewModel("r1", messageId)

    private fun TestScope.effectsOf(vm: SempRunViewModel): List<SempRunEffect> {
        val list = mutableListOf<SempRunEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    @Test fun `a finished run shows how it started went and what it cost`() = runTest(dispatcher) {
        val usage = listOf(SempRunUsage("Claude Sonnet", 2, 6_180, 240, 0.021))
        val runs = FakeSempRunRepository(
            runAnswer = RepositoryResult.Content(
                sempRun().copy(usage = usage, approvalCount = 2, pendingApprovalCount = 1),
            ),
            stepsAnswer = RepositoryResult.Content(
                SempRunStepsPage(listOf(sempRunStep("1"), sempRunStep("2")), null, true),
            ),
        )
        val vm = run(runs, "m1")
        assertEquals(SempRunPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val state = vm.state.value
        assertEquals(SempRunPhase.READY, state.phase)
        assertEquals("Move the invoice", state.run?.title)
        assertEquals(SempRunDisplay.DONE, state.run?.display)
        assertEquals(SempRunTriggerKind.USER, state.run?.trigger)
        assertEquals(4_100L, state.run?.durationMs)
        assertEquals(2, state.run?.approvalCount)
        assertEquals(1, state.run?.pendingApprovalCount)
        assertEquals("Claude Sonnet", state.run?.usage?.single()?.modelName)
        assertEquals(SempStepsPhase.READY, state.stepsPhase)
        assertEquals(listOf("Step 1", "Step 2"), state.steps.map { it.title })
        assertTrue(state.historyTruncated)
        assertEquals(listOf(Triple<String, String?, String?>("r1", "m1", null)), runs.stepCalls)
        vm.close()
    }

    @Test fun `a run that is still going is read again until it ends`() = runTest(dispatcher) {
        val runs = FakeSempRunRepository()
        runs.runAnswers += RepositoryResult.Content(sempRun(SempRunStatus.RUNNING))
        runs.runAnswers += RepositoryResult.Content(sempRun(SempRunStatus.RUNNING))
        runs.runAnswers += RepositoryResult.Content(sempRun(SempRunStatus.DONE))
        val vm = run(runs)
        runCurrent()
        assertEquals(SempRunDisplay.RUNNING, vm.state.value.run?.display)

        advanceTimeBy(2_100)
        assertEquals(SempRunDisplay.RUNNING, vm.state.value.run?.display)
        advanceTimeBy(2_100)
        assertEquals(SempRunDisplay.DONE, vm.state.value.run?.display)
        val calls = runs.runCalls
        advanceTimeBy(30_000)

        assertEquals(calls, runs.runCalls)
        vm.close()
    }

    @Test fun `a run that cannot be read is an error with its reason and retry reads it again`() = runTest(dispatcher) {
        val runs = FakeSempRunRepository(runAnswer = sempFailure(FailureKind.NOT_FOUND))
        val vm = run(runs)
        runCurrent()
        assertEquals(SempRunPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)

        runs.runAnswer = RepositoryResult.Content(sempRun())
        vm.onAction(SempRunAction.Retry)
        runCurrent()

        assertEquals(SempRunPhase.READY, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `steps that cannot be read leave the run itself shown`() = runTest(dispatcher) {
        val vm = run(FakeSempRunRepository(stepsAnswer = sempFailure()))
        runCurrent()

        assertEquals(SempRunPhase.READY, vm.state.value.phase)
        assertEquals(SempStepsPhase.ERROR, vm.state.value.stepsPhase)
        vm.close()
    }

    @Test fun `only a failed run of an automatic task that nothing retried can be retried`() = runTest(dispatcher) {
        val failedTick = sempRun(SempRunStatus.ERROR, SempRunTrigger.TICK)
        val retried = failedTick.copy(retriedByRunId = "r2")
        val chat = sempRun(SempRunStatus.ERROR, SempRunTrigger.USER)

        listOf(failedTick to true, retried to false, chat to false).forEach { (answer, expected) ->
            val vm = run(FakeSempRunRepository(runAnswer = RepositoryResult.Content(answer)))
            runCurrent()
            assertEquals(expected, vm.state.value.run?.canRetry)
            vm.close()
        }
    }

    @Test fun `retrying a run asks the server and reads the run again`() = runTest(dispatcher) {
        val runs = FakeSempRunRepository(runAnswer = RepositoryResult.Content(failedTick()))
        val vm = run(runs)
        runCurrent()

        vm.onAction(SempRunAction.RetryRun)
        runCurrent()

        assertEquals(listOf("r1"), runs.retried)
        assertFalse(vm.state.value.retrying)
        assertFalse(vm.state.value.retryFailed)
        assertEquals(2, runs.runCalls)
        vm.close()
    }

    @Test fun `a retry the server refused is shown and a run that cannot be retried is not asked`() =
        runTest(dispatcher) {
            val runs = FakeSempRunRepository(runAnswer = RepositoryResult.Content(failedTick()))
            runs.retryAnswer = sempFailure(FailureKind.REJECTED)
            val vm = run(runs)
            runCurrent()

            vm.onAction(SempRunAction.RetryRun)
            runCurrent()
            assertTrue(vm.state.value.retryFailed)
            vm.close()

            val done = FakeSempRunRepository()
            val other = run(done)
            runCurrent()
            other.onAction(SempRunAction.RetryRun)
            runCurrent()
            assertTrue(done.retried.isEmpty())
            other.close()
        }

    @Test fun `the thread and the approvals are opened by the app`() = runTest(dispatcher) {
        val vm = run(FakeSempRunRepository())
        val effects = effectsOf(vm)
        runCurrent()

        vm.onAction(SempRunAction.OpenThread)
        vm.onAction(SempRunAction.OpenApprovals)
        runCurrent()

        assertEquals(listOf(SempRunEffect.OpenThread("t1"), SempRunEffect.OpenApprovals), effects)
        vm.close()
    }

    @Test fun `a closed screen ignores actions`() = runTest(dispatcher) {
        val runs = FakeSempRunRepository()
        val vm = run(runs)
        runCurrent()
        vm.close()

        vm.onAction(SempRunAction.Retry)
        runCurrent()

        assertEquals(1, runs.runCalls)
    }
}
