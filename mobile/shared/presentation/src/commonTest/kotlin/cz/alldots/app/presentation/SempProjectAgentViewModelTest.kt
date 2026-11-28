package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempDrift
import cz.alldots.app.domain.SempDriftChoice
import cz.alldots.app.domain.SempDriftFinding
import cz.alldots.app.domain.SempDriftKind
import cz.alldots.app.domain.SempGuidance
import cz.alldots.app.domain.SempGuidanceDocument
import cz.alldots.app.domain.SempGuidanceSave
import cz.alldots.app.domain.SempProjectRun
import cz.alldots.app.domain.SempProjectTask
import cz.alldots.app.domain.SempRunStatus
import cz.alldots.app.domain.SempRunTrigger
import cz.alldots.app.domain.SempToolGrant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val behaviorFinding = SempDriftFinding(
    id = "f1",
    kind = SempDriftKind.BEHAVIOR,
    claim = "Creates tasks from issues",
    blocking = false,
    suggestedAllowedLine = "Create tasks from issues",
    suggestedNotAllowedLine = "Never create tasks",
)

private val permissionFinding = behaviorFinding.copy(
    id = "f2",
    kind = SempDriftKind.PERMISSION,
    blocking = true,
    suggestedAllowedLine = null,
    suggestedNotAllowedLine = null,
)

private val done = SempRunStatus.DONE
private val failed = SempRunStatus.ERROR

private fun projectRun(
    runId: String,
    messageId: String?,
    trigger: SempRunTrigger,
    status: SempRunStatus,
    durationMs: Long?,
    error: String? = null,
) = SempProjectRun("$runId:$messageId", runId, messageId, "Run $runId", trigger, "t", durationMs, 0.04, status, error)

private fun grant(id: String, server: String, granted: Boolean = false, asks: Boolean = false) =
    SempToolGrant(id, "Tool $id", id, asks, granted, server, "Server $server", true)

private fun task(id: String, enabled: Boolean = true, thread: String? = "th-$id") =
    SempProjectTask(id, "Task $id", "Daily", enabled, thread, "2026-10-21T08:30:00.000Z", false, false, null)

@OptIn(ExperimentalCoroutinesApi::class)
class SempProjectAgentViewModelTest : MainDispatcherTest() {

    private fun agent(fake: FakeSempProjectAgentRepository, runs: FakeSempRunRepository = FakeSempRunRepository()) =
        sempFactory(agent = fake, runs = runs).projectAgentViewModel("p1")

    private fun TestScope.effectsOf(vm: SempProjectAgentViewModel): List<SempProjectAgentEffect> {
        val list = mutableListOf<SempProjectAgentEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    @Test fun `shows the instructions the tools by server the tasks and the runs`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        fake.grantsAnswer = RepositoryResult.Content(
            listOf(grant("g1", "s1", true, true), grant("g2", "s1"), grant("g3", "s2")),
        )
        fake.tasksAnswer = RepositoryResult.Content(listOf(task("t1"), task("t2", enabled = false, thread = null)))
        val runs = FakeSempRunRepository(
            projectRunsAnswer = RepositoryResult.Content(
                listOf(
                    projectRun("r1", "m1", SempRunTrigger.TICK, done, 12_000L),
                    projectRun("r2", null, SempRunTrigger.USER, failed, null, "Timed out"),
                ),
            ),
        )
        val vm = agent(fake, runs)
        assertEquals(SempAgentPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val state = vm.state.value
        assertEquals(SempAgentPhase.READY, state.phase)
        assertEquals("Alldots iOS", state.projectName)
        assertEquals(SempSections("Help", "- read", "", "Czech"), state.sections)
        assertEquals(listOf("s1", "s2"), state.servers.map { it.id })
        assertEquals(listOf(true, false), state.servers.first().tools.map { it.granted })
        assertTrue(state.servers.first().tools.first().requiresApproval)
        assertEquals(listOf(true, false), state.tasks.map { it.enabled })
        assertEquals(SempRunTriggerKind.TICK, state.runs[0].trigger)
        assertEquals(SempRunDisplay.ERROR, state.runs[1].display)
        assertFalse(state.partialFailure)
        assertNull(state.finding)
        vm.close()
    }

    @Test fun `the page opens when only a part of it could not be read and says so`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        fake.tasksAnswer = sempFailure()
        val vm = agent(fake)
        runCurrent()

        assertEquals(SempAgentPhase.READY, vm.state.value.phase)
        assertTrue(vm.state.value.partialFailure)
        assertTrue(vm.state.value.tasks.isEmpty())
        vm.close()
    }

    @Test fun `instructions that cannot be read are an error with its reason and retry reads them again`() =
        runTest(dispatcher) {
            val fake = FakeSempProjectAgentRepository()
            fake.guidanceAnswer = sempFailure(FailureKind.NOT_FOUND)
            val vm = agent(fake)
            runCurrent()
            assertEquals(SempAgentPhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)

            fake.guidanceAnswer = RepositoryResult.Content(SempGuidanceDocument(SempGuidance("", "", "", ""), null))
            vm.onAction(SempProjectAgentAction.Retry)
            runCurrent()

            assertEquals(SempAgentPhase.READY, vm.state.value.phase)
            vm.close()
        }

    @Test fun `a changed part is saved with the whole text against the version it was read at`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        val vm = agent(fake)
        runCurrent()

        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.ALLOWED, "- read\n- write"))
        assertEquals(SempSaveState.SAVING, vm.state.value.saveState)
        runCurrent()

        assertEquals(SempGuidance("Help", "- read\n- write", "", "Czech") to "v1", fake.saves.single())
        assertEquals(SempSaveState.SAVED, vm.state.value.saveState)

        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.GENERAL, "Short"))
        runCurrent()
        assertEquals("v2", fake.saves.last().second)
        assertEquals(SempGuidance("Help", "- read\n- write", "", "Short"), fake.saves.last().first)
        vm.close()
    }

    @Test fun `a part that did not change is not saved`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        val vm = agent(fake)
        runCurrent()

        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.PURPOSE, "Help"))
        runCurrent()

        assertTrue(fake.saves.isEmpty())
        assertEquals(SempSaveState.IDLE, vm.state.value.saveState)
        vm.close()
    }

    @Test fun `a save that failed is kept and retried with everything typed since`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        fake.saveAnswer = sempFailure(FailureKind.UNAVAILABLE)
        val vm = agent(fake)
        runCurrent()

        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.PURPOSE, "New purpose"))
        runCurrent()
        assertEquals(SempSaveState.FAILED, vm.state.value.saveState)

        fake.saveAnswer = null
        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.NOT_ALLOWED, "- delete"))
        runCurrent()

        assertEquals(SempGuidance("New purpose", "- read", "- delete", "Czech"), fake.saves.last().first)
        assertEquals(SempSaveState.SAVED, vm.state.value.saveState)
        vm.close()
    }

    @Test fun `retry save sends what is still unsaved`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        fake.saveAnswer = sempFailure()
        val vm = agent(fake)
        runCurrent()
        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.PURPOSE, "New purpose"))
        runCurrent()

        fake.saveAnswer = null
        vm.onAction(SempProjectAgentAction.RetrySave)
        runCurrent()

        assertEquals(2, fake.saves.size)
        assertEquals(SempSaveState.SAVED, vm.state.value.saveState)
        vm.close()
    }

    @Test fun `instructions that changed meanwhile are taken from the server and the save says so`() =
        runTest(dispatcher) {
            val fake = FakeSempProjectAgentRepository()
            val newer = SempGuidanceDocument(SempGuidance("Newer", "", "", ""), "v7")
            fake.saveAnswer = RepositoryResult.Content(SempGuidanceSave.Conflict(newer))
            val vm = agent(fake)
            runCurrent()

            vm.onAction(SempProjectAgentAction.SaveSection(SempSection.PURPOSE, "Mine"))
            runCurrent()

            assertEquals(SempSaveState.CONFLICT, vm.state.value.saveState)
            assertEquals("Newer", vm.state.value.sections.purpose)
            fake.saveAnswer = null
            vm.onAction(SempProjectAgentAction.SaveSection(SempSection.PURPOSE, "Mine again"))
            runCurrent()
            assertEquals("v7", fake.saves.last().second)
            vm.close()
        }

    @Test fun `a drift finding of Semp's behaviour can be allowed which adds its line to the instructions`() =
        runTest(dispatcher) {
            val fake = FakeSempProjectAgentRepository()
            fake.driftAnswer = RepositoryResult.Content(SempDrift("v1", listOf(behaviorFinding)))
            val vm = agent(fake)
            runCurrent()
            val finding = vm.state.value.finding
            assertEquals("Creates tasks from issues", finding?.claim)
            assertTrue(finding?.canAllow == true && finding.canForbid)

            vm.onAction(SempProjectAgentAction.ResolveDrift(SempDriftAnswer.ALLOW))
            runCurrent()

            assertEquals(Triple("f1", SempDriftChoice.ALLOW, "v1"), fake.resolutions.single())
            assertNull(vm.state.value.finding)
            assertEquals("- read\n- tasks", vm.state.value.sections.allowed)
            assertEquals(SempSaveState.SAVED, vm.state.value.saveState)
            vm.close()
        }

    @Test fun `a permission finding can only be closed and a closed one does not touch the instructions`() =
        runTest(dispatcher) {
            val fake = FakeSempProjectAgentRepository()
            fake.driftAnswer = RepositoryResult.Content(SempDrift("v1", listOf(permissionFinding)))
            val vm = agent(fake)
            runCurrent()
            val finding = vm.state.value.finding
            assertTrue(finding?.canAllow == false && !finding.canForbid && finding.blocking)

            vm.onAction(SempProjectAgentAction.ResolveDrift(SempDriftAnswer.ALLOW))
            runCurrent()
            assertTrue(fake.resolutions.isEmpty())
            assertEquals(SempSaveState.FAILED, vm.state.value.saveState)

            vm.onAction(SempProjectAgentAction.ResolveDrift(SempDriftAnswer.DISMISS))
            runCurrent()
            assertEquals(SempDriftChoice.DISMISS, fake.resolutions.single().second)
            assertNull(vm.state.value.finding)
            vm.close()
        }

    @Test fun `a finding resolved against older instructions keeps the finding and takes the newer text`() =
        runTest(dispatcher) {
            val fake = FakeSempProjectAgentRepository()
            fake.driftAnswer = RepositoryResult.Content(SempDrift("v1", listOf(behaviorFinding)))
            fake.resolveAnswer = RepositoryResult.Content(
                SempGuidanceSave.Conflict(SempGuidanceDocument(SempGuidance("Newer", "", "", ""), "v5")),
            )
            val vm = agent(fake)
            runCurrent()

            vm.onAction(SempProjectAgentAction.ResolveDrift(SempDriftAnswer.FORBID))
            runCurrent()

            assertEquals(SempSaveState.CONFLICT, vm.state.value.saveState)
            assertEquals("Newer", vm.state.value.sections.purpose)
            assertEquals("f1", vm.state.value.finding?.id)
            vm.close()
        }

    @Test fun `a tool switches at once and goes back when the server refuses it`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        fake.grantsAnswer = RepositoryResult.Content(listOf(grant("g1", "s1")))
        val vm = agent(fake)
        runCurrent()

        vm.onAction(SempProjectAgentAction.SetTool("g1", granted = true))
        assertTrue(vm.state.value.servers.single().tools.single().granted)
        runCurrent()
        assertEquals(Triple("p1", "g1", true), fake.grantWrites.single())
        assertFalse(vm.state.value.changeFailed)

        fake.writeAnswer = sempFailure()
        vm.onAction(SempProjectAgentAction.SetTool("g1", granted = false))
        runCurrent()
        assertTrue(vm.state.value.servers.single().tools.single().granted)
        assertTrue(vm.state.value.changeFailed)
        vm.onAction(SempProjectAgentAction.DismissFailure)
        assertFalse(vm.state.value.changeFailed)
        vm.close()
    }

    @Test fun `an automatic task switches at once and goes back when the server refuses it`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        fake.tasksAnswer = RepositoryResult.Content(listOf(task("t1")))
        val vm = agent(fake)
        runCurrent()

        vm.onAction(SempProjectAgentAction.SetTask("t1", enabled = false))
        assertFalse(vm.state.value.tasks.single().enabled)
        runCurrent()
        assertEquals("t1" to false, fake.taskWrites.single())

        fake.writeAnswer = sempFailure()
        vm.onAction(SempProjectAgentAction.SetTask("t1", enabled = true))
        runCurrent()
        assertFalse(vm.state.value.tasks.single().enabled)
        assertTrue(vm.state.value.changeFailed)
        vm.close()
    }

    @Test fun `a task opens its thread and a run opens itself and a task without a thread opens nothing`() =
        runTest(dispatcher) {
            val fake = FakeSempProjectAgentRepository()
            fake.tasksAnswer = RepositoryResult.Content(listOf(task("t1"), task("t2", thread = null)))
            val runs = FakeSempRunRepository(
                projectRunsAnswer = RepositoryResult.Content(
                    listOf(projectRun("r1", "m1", SempRunTrigger.TICK, done, null)),
                ),
            )
            val vm = agent(fake, runs)
            val effects = effectsOf(vm)
            runCurrent()

            vm.onAction(SempProjectAgentAction.OpenTask("t1"))
            vm.onAction(SempProjectAgentAction.OpenTask("t2"))
            vm.onAction(SempProjectAgentAction.OpenRun("r1:m1"))
            runCurrent()

            assertEquals(
                listOf(SempProjectAgentEffect.OpenThread("th-t1"), SempProjectAgentEffect.OpenRun("r1", "m1")),
                effects,
            )
            vm.close()
        }

    @Test fun `a closed page ignores actions`() = runTest(dispatcher) {
        val fake = FakeSempProjectAgentRepository()
        val vm = agent(fake)
        runCurrent()
        vm.close()

        vm.onAction(SempProjectAgentAction.SaveSection(SempSection.PURPOSE, "Late"))
        runCurrent()

        assertTrue(fake.saves.isEmpty())
    }
}
