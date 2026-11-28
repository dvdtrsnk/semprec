package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
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
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun target(kind: SempTargetKind, itemId: String? = "i1", databaseId: String? = "d1") =
    SempTarget(kind, "Send invoice", "today 14:00", itemId, databaseId, null, null)

@OptIn(ExperimentalCoroutinesApi::class)
class SempBubbleViewModelTest : MainDispatcherTest() {
    private val session = SempSession()

    private fun bubble(
        chats: FakeSempRepository = FakeSempRepository(),
        approvals: FakeSempApprovalRepository = FakeSempApprovalRepository(),
    ) = sempFactory(chats = chats, approvals = approvals, session = session).bubbleViewModel()

    private fun TestScope.effectsOf(vm: SempBubbleViewModel): List<SempBubbleEffect> {
        val list = mutableListOf<SempBubbleEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    @Test fun `the badge counts the requests that wait for a decision and refresh reads it again`() =
        runTest(dispatcher) {
            val approvals = FakeSempApprovalRepository()
            val vm = bubble(approvals = approvals)
            runCurrent()
            assertEquals(1, vm.state.value.badge)

            approvals.pending += sempApproval("ap2")
            vm.onAction(SempBubbleAction.Refresh)
            runCurrent()

            assertEquals(2, vm.state.value.badge)
            vm.close()
        }

    @Test fun `a count that cannot be read keeps the badge it had`() = runTest(dispatcher) {
        val approvals = FakeSempApprovalRepository()
        val vm = bubble(approvals = approvals)
        runCurrent()
        approvals.listAnswer = sempFailure(FailureKind.UNAVAILABLE)
        val failing = object : cz.alldots.app.domain.SempApprovalRepository by approvals {
            override suspend fun pendingCount(): RepositoryResult<Int> = sempFailure()
        }
        val other = SempBubbleViewModel(
            session,
            cz.alldots.app.domain.CountSempApprovals(failing),
            cz.alldots.app.domain.ListSempThreads(FakeSempRepository()),
        )
        runCurrent()

        assertEquals(1, vm.state.value.badge)
        assertEquals(0, other.state.value.badge)
        vm.close()
        other.close()
    }

    @Test fun `an object dropped on the bubble is staged for the next message and the bubble says so`() =
        runTest(dispatcher) {
            val vm = bubble()
            runCurrent()

            vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.TASK)))
            runCurrent()

            assertEquals(SempBubbleToast.ADDED, vm.state.value.toast)
            assertEquals(1, vm.state.value.attachments)
            assertEquals(listOf(sempRefItem()), session.refs())
            vm.close()
        }

    @Test fun `the same object dropped again is not staged twice`() = runTest(dispatcher) {
        val vm = bubble()
        runCurrent()

        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.TASK)))
        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.TASK)))
        runCurrent()

        assertEquals(SempBubbleToast.ALREADY_ADDED, vm.state.value.toast)
        assertEquals(1, vm.state.value.attachments)
        vm.close()
    }

    @Test fun `an object Semp cannot be given is refused`() = runTest(dispatcher) {
        val vm = bubble()
        runCurrent()

        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.TASK, itemId = null)))
        runCurrent()

        assertEquals(SempBubbleToast.CANNOT_ADD, vm.state.value.toast)
        assertEquals(0, vm.state.value.attachments)
        vm.close()
    }

    @Test fun `mail and a run are staged by their own ids`() = runTest(dispatcher) {
        val vm = bubble()
        runCurrent()

        vm.onAction(SempBubbleAction.Drop(SempTarget(SempTargetKind.MAIL, "Mail", null, null, null, "m1", null)))
        vm.onAction(SempBubbleAction.Drop(SempTarget(SempTargetKind.RUN, "Run", null, null, null, null, "r1")))
        runCurrent()

        assertEquals(
            listOf(
                cz.alldots.app.domain.SempRefInput(cz.alldots.app.domain.SempRefKind.MAIL_THREAD, "m1", null),
                cz.alldots.app.domain.SempRefInput(cz.alldots.app.domain.SempRefKind.AGENT_RUN, "r1", null),
            ),
            session.refs(),
        )
        vm.close()
    }

    @Test fun `the notice goes away by itself after a moment`() = runTest(dispatcher) {
        val vm = bubble()
        runCurrent()

        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.TASK)))
        runCurrent()
        assertEquals(SempBubbleToast.ADDED, vm.state.value.toast)
        advanceTimeBy(2_700)

        assertNull(vm.state.value.toast)
        vm.close()
    }

    @Test fun `an inbox item opens a new thread of its own`() = runTest(dispatcher) {
        val chats = FakeSempRepository()
        val vm = bubble(chats)
        val effects = effectsOf(vm)
        runCurrent()

        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.INBOX)))
        runCurrent()

        assertEquals(SempBubbleToast.NEW_THREAD, vm.state.value.toast)
        assertEquals(listOf(SempBubbleEffect.OpenItemThread("i1", "Send invoice", "today 14:00")), effects)
        assertEquals("i1", chats.threadQueries.single().subjectInboxItemId)
        assertEquals(setOf(SempThreadKind.ITEM), chats.threadQueries.single().kinds)
        assertEquals(0, vm.state.value.attachments)
        vm.close()
    }

    @Test fun `an inbox item that has a thread continues it`() = runTest(dispatcher) {
        val chats = FakeSempRepository(
            threadsAnswer = RepositoryResult.Content(
                SempThreadsPage(listOf(sempThreadRow("t1", SempThreadKind.ITEM)), null),
            ),
        )
        val vm = bubble(chats)
        runCurrent()

        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.INBOX)))
        runCurrent()

        assertEquals(SempBubbleToast.CONTINUE_THREAD, vm.state.value.toast)
        vm.close()
    }

    @Test fun `an inbox item without an id is refused and a closed bubble ignores drops`() = runTest(dispatcher) {
        val vm = bubble()
        runCurrent()
        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.INBOX, itemId = null)))
        runCurrent()
        assertEquals(SempBubbleToast.CANNOT_ADD, vm.state.value.toast)

        vm.close()
        vm.onAction(SempBubbleAction.Drop(target(SempTargetKind.TASK)))
        runCurrent()
        assertTrue(session.refs().isEmpty())
    }
}
