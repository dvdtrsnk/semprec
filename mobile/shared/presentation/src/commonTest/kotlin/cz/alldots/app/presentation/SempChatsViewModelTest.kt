package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempApprovalExecution
import cz.alldots.app.domain.SempApprovalStatus
import cz.alldots.app.domain.SempPreview
import cz.alldots.app.domain.SempThreadKind
import cz.alldots.app.domain.SempThreadsPage
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
class SempChatsViewModelTest : MainDispatcherTest() {

    private fun chats(
        chats: FakeSempRepository = FakeSempRepository(),
        approvals: FakeSempApprovalRepository = FakeSempApprovalRepository(),
    ) = sempFactory(chats = chats, approvals = approvals).chatsViewModel()

    private fun TestScope.effectsOf(vm: SempChatsViewModel): List<SempChatsEffect> {
        val list = mutableListOf<SempChatsEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    private fun page(vararg rows: cz.alldots.app.domain.SempThreadRow, next: String? = null) =
        RepositoryResult.Content(SempThreadsPage(rows.toList(), next))

    @Test fun `loads the threads and the requests that wait with their count`() = runTest(dispatcher) {
        val fake =
            FakeSempRepository(threadsAnswer = page(sempThreadRow("t1"), sempThreadRow("t2", SempThreadKind.TICK)))
        val vm = chats(fake)
        assertEquals(SempChatsPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val state = vm.state.value
        assertEquals(SempChatsPhase.READY, state.phase)
        assertEquals(listOf("t1", "t2"), state.rows.map { it.id })
        assertEquals(SempThreadType.TICK, state.rows[1].type)
        assertEquals(1, state.approvals.size)
        assertEquals(1, state.approvalCount)
        assertEquals(
            setOf(SempThreadKind.CHAT, SempThreadKind.ITEM, SempThreadKind.TICK),
            fake.threadQueries.single().kinds,
        )
        vm.close()
    }

    @Test fun `a preview that is a system message keeps its key and a thread that waits is marked`() =
        runTest(dispatcher) {
            val row = sempThreadRow("t1")
                .copy(preview = SempPreview(null, "approval.outcome.executed"), hasPendingApproval = true)
            val vm = chats(FakeSempRepository(threadsAnswer = page(row)))
            runCurrent()

            assertEquals("approval.outcome.executed", vm.state.value.rows.single().previewSystemKey)
            assertNull(vm.state.value.rows.single().previewText)
            assertTrue(vm.state.value.rows.single().waiting)
            vm.close()
        }

    @Test fun `a filter asks for its kinds and keeps the rows while it reads`() = runTest(dispatcher) {
        val fake = FakeSempRepository(threadsAnswer = page(sempThreadRow("t1")))
        val vm = chats(fake)
        runCurrent()

        vm.onAction(SempChatsAction.SetFilter(SempChatsFilter.TICKS))
        assertEquals(SempChatsPhase.READY, vm.state.value.phase)
        runCurrent()
        vm.onAction(SempChatsAction.SetFilter(SempChatsFilter.CHATS))
        runCurrent()

        assertEquals(setOf(SempThreadKind.TICK), fake.threadQueries[1].kinds)
        assertEquals(setOf(SempThreadKind.CHAT, SempThreadKind.ITEM), fake.threadQueries[2].kinds)
        vm.close()
    }

    @Test fun `typing waits for a pause and only the last text is searched`() = runTest(dispatcher) {
        val fake = FakeSempRepository(threadsAnswer = page(sempThreadRow("t1")))
        val vm = chats(fake)
        runCurrent()

        vm.onAction(SempChatsAction.SetQuery("fa"))
        advanceTimeBy(100)
        vm.onAction(SempChatsAction.SetQuery("faktura"))
        advanceTimeBy(400)

        assertEquals(listOf("", "faktura"), fake.threadQueries.map { it.search.orEmpty() })
        assertEquals("faktura", vm.state.value.query)
        vm.close()
    }

    @Test fun `a failure keeps its reason and retry reads again`() = runTest(dispatcher) {
        val fake = FakeSempRepository(threadsAnswer = sempFailure(FailureKind.UNAUTHORIZED))
        val vm = chats(fake)
        runCurrent()
        assertEquals(SempChatsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)

        fake.threadsAnswer = page(sempThreadRow("t1"))
        vm.onAction(SempChatsAction.Retry)
        runCurrent()

        assertEquals(SempChatsPhase.READY, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `more rows are added after the ones shown`() = runTest(dispatcher) {
        val fake = FakeSempRepository(threadsAnswer = page(sempThreadRow("t1"), next = "c1"))
        val vm = chats(fake)
        runCurrent()
        assertTrue(vm.state.value.hasMore)

        fake.threadsAnswer = page(sempThreadRow("t2"))
        vm.onAction(SempChatsAction.LoadMore)
        runCurrent()

        assertEquals(listOf("t1", "t2"), vm.state.value.rows.map { it.id })
        assertFalse(vm.state.value.hasMore)
        assertEquals("c1", fake.threadQueries.last().cursor)
        vm.close()
    }

    @Test fun `approving a request here follows it and reads the list again`() = runTest(dispatcher) {
        val approvals = FakeSempApprovalRepository()
        approvals.getAnswers += RepositoryResult.Content(
            sempApproval(status = SempApprovalStatus.APPROVED, execution = SempApprovalExecution.SUCCEEDED),
        )
        val vm = chats(approvals = approvals)
        runCurrent()

        vm.onAction(SempChatsAction.Decide("ap1", approve = true))
        runCurrent()
        assertEquals(SempDecisionState.QUEUED, vm.state.value.approvals.single().decision)
        approvals.pending.clear()
        advanceTimeBy(1_600)
        runCurrent()

        assertEquals(listOf("ap1" to true), approvals.decisions)
        assertTrue(vm.state.value.approvals.isEmpty())
        assertEquals(0, vm.state.value.approvalCount)
        vm.close()
    }

    @Test fun `a request that could not be decided stays pending with the failure`() = runTest(dispatcher) {
        val approvals = FakeSempApprovalRepository()
        approvals.decideAnswer = sempFailure(FailureKind.UNAVAILABLE)
        val vm = chats(approvals = approvals)
        runCurrent()

        vm.onAction(SempChatsAction.Decide("ap1", approve = false))
        runCurrent()

        val card = vm.state.value.approvals.single()
        assertEquals(SempDecisionState.PENDING, card.decision)
        assertTrue(card.decisionFailed)
        vm.close()
    }

    @Test fun `opening a thread the approvals or a new chat is an effect and an unknown thread is not`() =
        runTest(dispatcher) {
            val vm = chats(FakeSempRepository(threadsAnswer = page(sempThreadRow("t1"))))
            val effects = effectsOf(vm)
            runCurrent()

            vm.onAction(SempChatsAction.OpenThread("t1"))
            vm.onAction(SempChatsAction.OpenThread("missing"))
            vm.onAction(SempChatsAction.OpenApprovals)
            vm.onAction(SempChatsAction.OpenNewChat)
            runCurrent()

            assertEquals(3, effects.size)
            assertEquals("t1", (effects[0] as SempChatsEffect.OpenThread).row.id)
            assertEquals(SempChatsEffect.OpenApprovals, effects[1])
            assertEquals(SempChatsEffect.OpenNewChat, effects[2])
            vm.close()
        }

    @Test fun `a closed screen ignores actions and a read that answers late shows nothing`() = runTest(dispatcher) {
        val fake = FakeSempRepository(threadsAnswer = page(sempThreadRow("t1")))
        val vm = chats(fake)
        vm.close()
        runCurrent()
        vm.onAction(SempChatsAction.SetFilter(SempChatsFilter.TICKS))

        assertEquals(SempChatsPhase.LOADING, vm.state.value.phase)
        assertEquals(SempChatsFilter.ALL, vm.state.value.filter)
    }
}
