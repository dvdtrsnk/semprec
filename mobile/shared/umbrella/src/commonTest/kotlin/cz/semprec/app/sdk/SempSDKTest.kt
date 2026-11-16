package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.SempAgentPhase
import cz.semprec.app.presentation.SempApprovalsPhase
import cz.semprec.app.presentation.SempChatsPhase
import cz.semprec.app.presentation.SempRunPhase
import cz.semprec.app.presentation.SempStatusPhase
import cz.semprec.app.presentation.SempThreadPhase
import cz.semprec.app.presentation.SempThreadStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SempSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new Semp ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK().semp
        val first = sdk.chatsViewModel()
        val second = sdk.chatsViewModel()
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()

        val thread = sdk.threadViewModel(SempThreadStart.NEW, null, null, null, null)
        assertNotSame(thread, sdk.threadViewModel(SempThreadStart.NEW, null, null, null, null).also { it.close() })
        thread.close()
        sdk.bubbleViewModel().close()
        sdk.statusViewModel().close()
        sdk.approvalsViewModel().close()
        sdk.runViewModel("r1", null).close()
        sdk.projectAgentViewModel("p1").close()
    }

    @Test fun `without a session every Semp screen fails as unauthorized`() = runTest(dispatcher) {
        val sdk = HomeSDK().semp
        val chats = sdk.chatsViewModel()
        val status = sdk.statusViewModel()
        val approvals = sdk.approvalsViewModel()
        val run = sdk.runViewModel("r1", null)
        val agent = sdk.projectAgentViewModel("p1")
        val thread = sdk.threadViewModel(SempThreadStart.EXISTING, "t1", null, null, null)
        runCurrent()

        assertEquals(SempChatsPhase.ERROR, chats.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, chats.state.value.failure)
        assertEquals(SempStatusPhase.ERROR, status.state.value.phase)
        assertEquals(SempApprovalsPhase.ERROR, approvals.state.value.phase)
        assertEquals(SempRunPhase.ERROR, run.state.value.phase)
        assertEquals(SempAgentPhase.ERROR, agent.state.value.phase)
        assertEquals(SempThreadPhase.ERROR, thread.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, thread.state.value.failure)
        listOf(chats, status, approvals, run, agent, thread).forEach { it.close() }
    }

    @Test fun `the session of the bubble is shared by the screens of one SDK and not by another`() =
        runTest(dispatcher) {
            val sdk = HomeSDK().semp
            val other = HomeSDK().semp
            val bubble = sdk.bubbleViewModel()
            val sameWindow = sdk.threadViewModel(SempThreadStart.NEW, null, null, null, null)
            val otherWindow = other.threadViewModel(SempThreadStart.NEW, null, null, null, null)
            runCurrent()

            bubble.onAction(
                cz.semprec.app.presentation.SempBubbleAction.Drop(
                    cz.semprec.app.presentation.SempTarget(
                        cz.semprec.app.presentation.SempTargetKind.TASK, "Send invoice", null, "i1", "d1", null, null,
                    ),
                ),
            )
            runCurrent()

            assertEquals(1, sameWindow.state.value.attachments.size)
            assertTrue(otherWindow.state.value.attachments.isEmpty())
            listOf(bubble, sameWindow, otherWindow).forEach { it.close() }
        }
}
