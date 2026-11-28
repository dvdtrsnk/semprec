package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempApprovalExecution
import cz.alldots.app.domain.SempApprovalStatus
import cz.alldots.app.domain.SempApprovalsPage
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

@OptIn(ExperimentalCoroutinesApi::class)
class SempApprovalsViewModelTest : MainDispatcherTest() {

    private val queued = SempApprovalExecution.QUEUED
    private val done = SempApprovalExecution.SUCCEEDED

    private fun approved(execution: SempApprovalExecution) =
        sempApproval(status = SempApprovalStatus.APPROVED, execution = execution)

    private fun approvals(fake: FakeSempApprovalRepository) = sempFactory(approvals = fake).approvalsViewModel()

    private fun TestScope.effectsOf(vm: SempApprovalsViewModel): List<SempApprovalsEffect> {
        val list = mutableListOf<SempApprovalsEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    @Test fun `shows the requests that wait with their count and what each is about`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        val vm = approvals(fake)
        assertEquals(SempApprovalsPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val item = vm.state.value.items.single()
        assertEquals(SempApprovalsPhase.READY, vm.state.value.phase)
        assertEquals(SempApprovalsTab.PENDING, vm.state.value.tab)
        assertEquals(1, vm.state.value.pendingCount)
        assertEquals("approval.itemDelete", item.descriptionKey)
        assertEquals(mapOf("itemName" to "Tax return"), item.descriptionParams)
        assertEquals(SempRisk.IRREVERSIBLE, item.risk)
        assertEquals(SempOrigin.CHAT, item.origin)
        assertEquals(listOf("itemId"), item.argumentKeys)
        assertEquals(SempDecisionState.PENDING, item.decision)
        vm.close()
    }

    @Test fun `the decided tab lists what was decided and how it came out`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        fake.decided += sempApproval("d1", SempApprovalStatus.APPROVED, SempApprovalExecution.CONFLICT)
            .copy(conflictKey = "approval.conflict.deleted")
        fake.decided += sempApproval("d2", SempApprovalStatus.REJECTED)
        val vm = approvals(fake)
        runCurrent()

        vm.onAction(SempApprovalsAction.SetTab(SempApprovalsTab.DECIDED))
        assertEquals(SempApprovalsPhase.LOADING, vm.state.value.phase)
        runCurrent()

        assertEquals(listOf(false), fake.listCalls.drop(1).map { it.first })
        assertEquals(
            listOf(SempDecisionState.CONFLICT, SempDecisionState.REJECTED),
            vm.state.value.items.map { it.decision },
        )
        assertEquals("approval.conflict.deleted", vm.state.value.items.first().conflictKey)
        vm.close()
    }

    @Test fun `choosing the tab that is open reads nothing again`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        val vm = approvals(fake)
        runCurrent()

        vm.onAction(SempApprovalsAction.SetTab(SempApprovalsTab.PENDING))
        runCurrent()

        assertEquals(1, fake.listCalls.size)
        vm.close()
    }

    @Test fun `approving follows the request from queued to carried out and counts what still waits`() =
        runTest(dispatcher) {
            val fake = FakeSempApprovalRepository()
            fake.getAnswers += RepositoryResult.Content(approved(queued))
            fake.getAnswers += RepositoryResult.Content(approved(done))
            val vm = approvals(fake)
            runCurrent()

            vm.onAction(SempApprovalsAction.Decide("ap1", approve = true))
            runCurrent()
            assertEquals(SempDecisionState.QUEUED, vm.state.value.items.single().decision)

            advanceTimeBy(1_600)
            assertEquals(SempDecisionState.QUEUED, vm.state.value.items.single().decision)
            advanceTimeBy(1_600)
            assertEquals(SempDecisionState.EXECUTED, vm.state.value.items.single().decision)
            assertEquals(listOf("ap1" to true), fake.decisions)
            vm.close()
        }

    @Test fun `a request that conflicted when it was carried out says so`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        fake.getAnswers += RepositoryResult.Content(
            sempApproval(status = SempApprovalStatus.APPROVED, execution = SempApprovalExecution.CONFLICT)
                .copy(conflictKey = "approval.conflict.deleted"),
        )
        val vm = approvals(fake)
        runCurrent()

        vm.onAction(SempApprovalsAction.Decide("ap1", approve = true))
        runCurrent()
        advanceTimeBy(1_600)

        assertEquals(SempDecisionState.CONFLICT, vm.state.value.items.single().decision)
        assertEquals("approval.conflict.deleted", vm.state.value.items.single().conflictKey)
        vm.close()
    }

    @Test fun `rejecting is final at once and a failed decision leaves the request pending`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        fake.decideAnswer = RepositoryResult.Content(sempApproval(status = SempApprovalStatus.REJECTED))
        val vm = approvals(fake)
        runCurrent()
        vm.onAction(SempApprovalsAction.Decide("ap1", approve = false))
        runCurrent()
        assertEquals(SempDecisionState.REJECTED, vm.state.value.items.single().decision)
        assertEquals(listOf("ap1" to false), fake.decisions)

        val failing = FakeSempApprovalRepository()
        failing.decideAnswer = sempFailure(FailureKind.UNAVAILABLE)
        val other = approvals(failing)
        runCurrent()
        other.onAction(SempApprovalsAction.Decide("ap1", approve = true))
        runCurrent()
        val item = other.state.value.items.single()
        assertEquals(SempDecisionState.PENDING, item.decision)
        assertTrue(item.decisionFailed)
        assertEquals(FailureKind.UNAVAILABLE, item.decisionFailure)
        vm.close()
        other.close()
    }

    @Test fun `a request is not decided twice while a decision is on its way`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        val vm = approvals(fake)
        runCurrent()

        vm.onAction(SempApprovalsAction.Decide("ap1", approve = true))
        vm.onAction(SempApprovalsAction.Decide("ap1", approve = false))
        runCurrent()

        assertEquals(listOf("ap1" to true), fake.decisions)
        vm.close()
    }

    @Test fun `a request that is not in the list is not decided`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        val vm = approvals(fake)
        runCurrent()

        vm.onAction(SempApprovalsAction.Decide("missing", approve = true))
        runCurrent()

        assertTrue(fake.decisions.isEmpty())
        vm.close()
    }

    @Test fun `details open and close and the thread and run of a request are opened by the app`() =
        runTest(dispatcher) {
            val vm = approvals(FakeSempApprovalRepository())
            val effects = effectsOf(vm)
            runCurrent()

            vm.onAction(SempApprovalsAction.ToggleDetails("ap1"))
            assertTrue("ap1" in vm.state.value.expanded)
            vm.onAction(SempApprovalsAction.ToggleDetails("ap1"))
            assertFalse("ap1" in vm.state.value.expanded)
            vm.onAction(SempApprovalsAction.OpenThread("ap1"))
            vm.onAction(SempApprovalsAction.OpenRun("ap1"))
            vm.onAction(SempApprovalsAction.OpenThread("missing"))
            runCurrent()

            assertEquals(listOf(SempApprovalsEffect.OpenThread("t1"), SempApprovalsEffect.OpenRun("r1")), effects)
            vm.close()
        }

    @Test fun `more requests are added after the ones shown`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        fake.listAnswer = RepositoryResult.Content(SempApprovalsPage(listOf(sempApproval("a1")), "next"))
        val vm = approvals(fake)
        runCurrent()
        assertTrue(vm.state.value.hasMore)

        fake.listAnswer = RepositoryResult.Content(SempApprovalsPage(listOf(sempApproval("a2")), null))
        vm.onAction(SempApprovalsAction.LoadMore)
        runCurrent()

        assertEquals(listOf("a1", "a2"), vm.state.value.items.map { it.id })
        assertFalse(vm.state.value.hasMore)
        assertEquals(true to "next", fake.listCalls.last())
        vm.close()
    }

    @Test fun `a failure keeps its reason and retry reads the queue again`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        fake.listAnswer = sempFailure(FailureKind.UNAUTHORIZED)
        val vm = approvals(fake)
        runCurrent()
        assertEquals(SempApprovalsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)

        fake.listAnswer = null
        vm.onAction(SempApprovalsAction.Retry)
        runCurrent()

        assertEquals(SempApprovalsPhase.READY, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a closed screen ignores actions`() = runTest(dispatcher) {
        val fake = FakeSempApprovalRepository()
        val vm = approvals(fake)
        runCurrent()
        vm.close()

        vm.onAction(SempApprovalsAction.Decide("ap1", approve = true))
        runCurrent()

        assertTrue(fake.decisions.isEmpty())
    }
}
