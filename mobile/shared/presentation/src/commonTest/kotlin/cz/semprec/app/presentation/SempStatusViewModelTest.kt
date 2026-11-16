package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempProblem
import cz.semprec.app.domain.SempProblemAction
import cz.semprec.app.domain.SempProblemSeverity
import cz.semprec.app.domain.SempResolvedProblem
import cz.semprec.app.domain.SempService
import cz.semprec.app.domain.SempStatusReport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun problem(id: String, vararg actions: SempProblemAction) = SempProblem(
    id = id,
    category = "agents",
    severity = SempProblemSeverity.CRITICAL,
    title = "Semp did not finish",
    text = "Timed out.",
    shortText = "Timed out",
    since = "2026-10-21T09:05:00.000Z",
    mergedCount = 2,
    projectName = "Semprec iOS",
    actions = actions.toList(),
)

private fun report(vararg problems: SempProblem) = SempStatusReport(
    activeCount = problems.size,
    services = listOf(SempService("agents", "Semp and agents", "2026-10-21T09:05:00.000Z", null)),
    problems = problems.toList(),
    resolved = listOf(SempResolvedProblem("x", "Queue is empty", "2026-10-20T16:40:00.000Z")),
)

@OptIn(ExperimentalCoroutinesApi::class)
class SempStatusViewModelTest : MainDispatcherTest() {

    private fun status(
        fake: FakeSempStatusRepository,
        runs: FakeSempRunRepository = FakeSempRunRepository(),
        chats: FakeSempRepository = FakeSempRepository(),
        agent: FakeSempProjectAgentRepository = FakeSempProjectAgentRepository(),
    ) = sempFactory(chats = chats, status = fake, runs = runs, agent = agent).statusViewModel()

    private fun TestScope.effectsOf(vm: SempStatusViewModel): List<SempStatusEffect> {
        val list = mutableListOf<SempStatusEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    @Test fun `shows the problems with the one fix and the one link each has and the services`() = runTest(dispatcher) {
        val fake = FakeSempStatusRepository(
            reportAnswer = RepositoryResult.Content(
                report(
                    problem("p1", SempProblemAction.RetryRun("r1"), SempProblemAction.OpenThread("t1")),
                    problem("p2", SempProblemAction.DisableHeartbeat("h1"), SempProblemAction.OpenProject("pr1")),
                    problem("p3"),
                ),
            ),
        )
        val vm = status(fake)
        assertEquals(SempStatusPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val issues = vm.state.value.issues
        assertEquals(SempStatusPhase.READY, vm.state.value.phase)
        assertEquals(SempIssueFix.RETRY, issues[0].fix)
        assertEquals(SempIssueLink.THREAD, issues[0].link)
        assertEquals(SempIssueFix.DISABLE_AUTOMATION, issues[1].fix)
        assertEquals(SempIssueLink.PROJECT, issues[1].link)
        assertNull(issues[2].fix)
        assertNull(issues[2].link)
        assertTrue(issues[0].critical)
        assertEquals(2, issues[0].mergedCount)
        assertEquals("Semp and agents", vm.state.value.services.single().name)
        assertEquals("Queue is empty", vm.state.value.resolved.single().title)
        vm.close()
    }

    @Test fun `no problem is a report with only services`() = runTest(dispatcher) {
        val vm = status(FakeSempStatusRepository(reportAnswer = RepositoryResult.Content(report())))
        runCurrent()

        assertTrue(vm.state.value.issues.isEmpty())
        assertEquals(SempStatusPhase.READY, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a failure keeps its reason and retry reads the report again`() = runTest(dispatcher) {
        val fake = FakeSempStatusRepository(reportAnswer = sempFailure(FailureKind.UNAVAILABLE))
        val vm = status(fake)
        runCurrent()
        assertEquals(SempStatusPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)

        fake.reportAnswer = RepositoryResult.Content(report())
        vm.onAction(SempStatusAction.Retry)
        assertEquals(SempStatusPhase.LOADING, vm.state.value.phase)
        runCurrent()

        assertEquals(SempStatusPhase.READY, vm.state.value.phase)
        assertEquals(2, fake.reportCalls)
        vm.close()
    }

    @Test fun `fixing a failed run retries it and reads the report again without a loading state`() =
        runTest(dispatcher) {
            val fake = FakeSempStatusRepository(
                reportAnswer = RepositoryResult.Content(report(problem("p1", SempProblemAction.RetryRun("r1")))),
            )
            val runs = FakeSempRunRepository()
            val vm = status(fake, runs)
            runCurrent()

            fake.reportAnswer = RepositoryResult.Content(report())
            vm.onAction(SempStatusAction.Fix("p1"))
            assertTrue(vm.state.value.issues.single().busy)
            runCurrent()

            assertEquals(listOf("r1"), runs.retried)
            assertTrue(vm.state.value.issues.isEmpty())
            vm.close()
        }

    @Test fun `a fix is not started twice while it runs`() = runTest(dispatcher) {
        val fake = FakeSempStatusRepository(
            reportAnswer = RepositoryResult.Content(report(problem("p1", SempProblemAction.RetryRun("r1")))),
        )
        val runs = FakeSempRunRepository()
        val vm = status(fake, runs)
        runCurrent()

        vm.onAction(SempStatusAction.Fix("p1"))
        vm.onAction(SempStatusAction.Fix("p1"))
        runCurrent()

        assertEquals(listOf("r1"), runs.retried)
        vm.close()
    }

    @Test fun `a fix the server refused is marked on its problem and can be tried again`() = runTest(dispatcher) {
        val fake = FakeSempStatusRepository(
            reportAnswer = RepositoryResult.Content(report(problem("p1", SempProblemAction.RetryRun("r1")))),
        )
        val runs = FakeSempRunRepository()
        runs.retryAnswer = sempFailure(FailureKind.REJECTED)
        val vm = status(fake, runs)
        runCurrent()

        vm.onAction(SempStatusAction.Fix("p1"))
        runCurrent()
        assertTrue(vm.state.value.issues.single().fixFailed)
        assertFalse(vm.state.value.issues.single().busy)

        runs.retryAnswer = sempContent()
        vm.onAction(SempStatusAction.Fix("p1"))
        runCurrent()
        assertEquals(2, runs.retried.size)
        vm.close()
    }

    @Test fun `retrying a reply and switching off an automation call their own writes`() = runTest(dispatcher) {
        val fake = FakeSempStatusRepository(
            reportAnswer = RepositoryResult.Content(
                report(
                    problem("p1", SempProblemAction.RetryPrompt("t1", "m1")),
                    problem("p2", SempProblemAction.DisableHeartbeat("h1")),
                ),
            ),
        )
        val chats = FakeSempRepository()
        val agent = FakeSempProjectAgentRepository()
        val vm = status(fake, chats = chats, agent = agent)
        runCurrent()

        vm.onAction(SempStatusAction.Fix("p1"))
        vm.onAction(SempStatusAction.Fix("p2"))
        runCurrent()

        assertEquals(listOf("t1" to "m1"), chats.retries)
        assertEquals(listOf("h1" to false), agent.taskWrites)
        vm.close()
    }

    @Test fun `the link of a problem opens its chat its thread or its project`() = runTest(dispatcher) {
        val fake = FakeSempStatusRepository(
            reportAnswer = RepositoryResult.Content(
                report(
                    problem("p1", SempProblemAction.OpenChat("t1", "m1")),
                    problem("p2", SempProblemAction.OpenThread("t2")),
                    problem("p3", SempProblemAction.OpenProject("pr1")),
                    problem("p4"),
                ),
            ),
        )
        val vm = status(fake)
        val effects = effectsOf(vm)
        runCurrent()

        listOf("p1", "p2", "p3", "p4", "missing").forEach { vm.onAction(SempStatusAction.Open(it)) }
        runCurrent()

        assertEquals(
            listOf(
                SempStatusEffect.OpenChat("t1", "m1"),
                SempStatusEffect.OpenThread("t2"),
                SempStatusEffect.OpenProject("pr1"),
            ),
            effects,
        )
        vm.close()
    }

    @Test fun `the history of resolved problems opens and closes`() = runTest(dispatcher) {
        val vm = status(FakeSempStatusRepository(reportAnswer = RepositoryResult.Content(report())))
        runCurrent()

        vm.onAction(SempStatusAction.ToggleHistory)
        assertTrue(vm.state.value.historyOpen)
        vm.onAction(SempStatusAction.ToggleHistory)
        assertFalse(vm.state.value.historyOpen)
        vm.close()
    }

    @Test fun `a report that answers after the screen was closed shows nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val fake = object : cz.semprec.app.domain.SempStatusRepository {
            override suspend fun report(): RepositoryResult<SempStatusReport> {
                withContext(NonCancellable) { gate.await() }
                return RepositoryResult.Content(report(problem("p1")))
            }

            override suspend fun summary() =
                RepositoryResult.Content(cz.semprec.app.domain.SempStatusSummary(0, null, null, null))
        }
        val vm = SempStatusViewModel(
            cz.semprec.app.domain.LoadSempStatus(fake),
            SempStatusFixes(
                cz.semprec.app.domain.RetrySempRun(FakeSempRunRepository()),
                cz.semprec.app.domain.RetrySempReply(FakeSempRepository()),
                cz.semprec.app.domain.EditSempProjectAgent(FakeSempProjectAgentRepository()),
            ),
        )
        runCurrent()

        vm.close()
        gate.complete(Unit)
        runCurrent()

        assertEquals(SempStatusPhase.LOADING, vm.state.value.phase)
        assertTrue(vm.state.value.issues.isEmpty())
    }
}
