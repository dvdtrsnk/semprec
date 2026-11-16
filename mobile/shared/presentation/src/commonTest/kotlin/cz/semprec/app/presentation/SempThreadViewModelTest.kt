package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempApprovalExecution
import cz.semprec.app.domain.SempApprovalStatus
import cz.semprec.app.domain.SempMessageStatus
import cz.semprec.app.domain.SempStatusSummary
import cz.semprec.app.domain.SempStepApproval
import cz.semprec.app.domain.SempStepStatus
import cz.semprec.app.domain.SempThreadKind
import cz.semprec.app.domain.SempThreadsPage
import cz.semprec.app.domain.SempTickHeader
import kotlinx.coroutines.CompletableDeferred
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

private const val T1 = "2026-10-21T13:24:00.000000Z"
private const val T2 = "2026-10-21T13:24:06.000000Z"
private const val T3 = "2026-10-21T13:25:00.000000Z"

@OptIn(ExperimentalCoroutinesApi::class)
class SempThreadViewModelTest : MainDispatcherTest() {
    private val session = SempSession()

    private fun thread(
        chats: FakeSempRepository,
        start: SempThreadStart = SempThreadStart.EXISTING,
        approvals: FakeSempApprovalRepository = FakeSempApprovalRepository(),
        agent: FakeSempProjectAgentRepository = FakeSempProjectAgentRepository(),
        status: FakeSempStatusRepository = FakeSempStatusRepository(),
        runs: FakeSempRunRepository = FakeSempRunRepository(),
    ) = sempFactory(chats, status, runs, approvals, agent, session)
        .threadViewModel(
            start,
            "t1".takeIf {
                start == SempThreadStart.EXISTING
            },
            "inbox-1".takeIf { start == SempThreadStart.ITEM }, null, null
        )

    private fun TestScope.effectsOf(vm: SempThreadViewModel): List<SempThreadEffect> {
        val list = mutableListOf<SempThreadEffect>()
        backgroundScope.launch { vm.effects.toList(list) }
        return list
    }

    private fun chatWith(vararg messages: cz.semprec.app.domain.SempMessage) =
        FakeSempRepository(messageAnswers = mutableListOf(sempConversationPage(*messages)))

    @Test fun `an existing thread shows the messages oldest first with the run the changes and the chips`() =
        runTest(dispatcher) {
            val reply = sempReply(
                "a1", "u1", T2, runId = "r1", steps = listOf(sempStep(), sempStep(durationMs = 600)),
                changes = listOf(sempChange()),
            )
            val vm = thread(chatWith(reply, sempUser("u1", "Move it", T1, listOf(sempChip()))))
            assertEquals(SempThreadPhase.LOADING, vm.state.value.phase)
            runCurrent()

            val state = vm.state.value
            assertEquals(SempThreadPhase.READY, state.phase)
            assertEquals("t1", state.threadId)
            assertEquals(listOf("u1", "a1"), state.entries.map { it.id })
            assertEquals(SempTargetKind.TASK, state.entries[0].chips.single().kind)
            assertEquals("Send invoice", state.entries[0].chips.single().label)
            val run = state.entries[1].run
            assertEquals(2, run?.stepCount)
            assertEquals(1_000L, run?.durationMs)
            assertEquals(SempRunChipState.OK, run?.state)
            assertEquals(SempChangeType.UPDATED, state.entries[1].changes.single().change)
            assertEquals(SempTargetKind.TASK, state.entries[1].changes.single().kind)
            assertTrue(state.entries[1].canRegenerate)
            assertFalse(state.canAttach.not())
            vm.close()
        }

    @Test fun `only the newest attempt of a reply is shown and a replaced answer is hidden`() = runTest(dispatcher) {
        val vm = thread(
            chatWith(
                sempUser("u1", "Hi", T1),
                sempReply("a1", "u1", T2, status = SempMessageStatus.ERROR, attempt = 1),
                sempReply("a2", "u1", T3, attempt = 2),
                sempReply("a0", "u1", T2, replaced = true, attempt = 1),
            ),
        )
        runCurrent()

        assertEquals(listOf("u1", "a2"), vm.state.value.entries.map { it.id })
        vm.close()
    }

    @Test fun `a thread that cannot be read is an error with its reason and retry reads it again`() =
        runTest(dispatcher) {
            val chats = chatWith(sempUser("u1", "Hi", T1))
            chats.threadAnswers["t1"] = sempFailure(FailureKind.NOT_FOUND)
            val vm = thread(chats)
            runCurrent()
            assertEquals(SempThreadPhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)

            chats.threadAnswers["t1"] = RepositoryResult.Content(sempThread())
            vm.onAction(SempThreadAction.Retry)
            assertEquals(SempThreadPhase.LOADING, vm.state.value.phase)
            runCurrent()
            assertEquals(SempThreadPhase.READY, vm.state.value.phase)
            assertNull(vm.state.value.failure)
            vm.close()
        }

    @Test fun `the latest chat opens on the newest chat thread or on an empty one when there is none`() =
        runTest(dispatcher) {
            val none = FakeSempRepository()
            val empty = thread(none, SempThreadStart.LATEST)
            runCurrent()
            assertEquals(SempThreadPhase.READY, empty.state.value.phase)
            assertNull(empty.state.value.threadId)
            assertEquals(setOf(SempThreadKind.CHAT), none.threadQueries.single().kinds)
            empty.close()

            val some = chatWith(sempUser("u1", "Hi", T1))
            some.threadsAnswer = RepositoryResult.Content(SempThreadsPage(listOf(sempThreadRow("t7")), null))
            val found = thread(some, SempThreadStart.LATEST)
            runCurrent()
            assertEquals("t7", found.state.value.threadId)
            found.close()
        }

    @Test fun `the thread of an inbox item is looked up by its subject and started by the first message`() =
        runTest(dispatcher) {
            val chats = chatWith(sempUser("u1", "Hi", T1))
            chats.sendAnswers += sempReceipt("t9")
            val vm = thread(chats, SempThreadStart.ITEM)
            runCurrent()
            assertEquals("inbox-1", chats.threadQueries.single().subjectInboxItemId)
            assertEquals(SempThreadType.ITEM, vm.state.value.type)
            assertFalse(vm.state.value.canAttach)

            vm.onAction(SempThreadAction.Send("Not that"))
            runCurrent()

            assertEquals("inbox-1", chats.sent.single().subjectInboxItemId)
            assertNull(chats.sent.single().threadId)
            vm.close()
        }

    @Test fun `a message shows as sending then is read back from the server and the staged objects go with it`() =
        runTest(dispatcher) {
            val chats = FakeSempRepository(
                messageAnswers = mutableListOf(
                    sempConversationPage(sempUser("m1", "Move it", T1), sempReply("m2", "m1", T2)),
                ),
            )
            chats.sendAnswers += sempReceipt("t5")
            chats.sendGate = CompletableDeferred()
            val vm = thread(chats, SempThreadStart.NEW)
            runCurrent()
            session.stage(SempTarget(SempTargetKind.TASK, "Send invoice", null, "i1", "d1", null, null))
            runCurrent()
            assertEquals(1, vm.state.value.attachments.size)

            vm.onAction(SempThreadAction.Send("  Move it  "))
            runCurrent()
            val sending = vm.state.value.entries.single()
            assertEquals(SempDelivery.SENDING, sending.delivery)
            assertEquals("Move it", sending.text)
            assertTrue(vm.state.value.sending)

            chats.sendGate?.complete(Unit)
            runCurrent()

            assertEquals(listOf("m1", "m2"), vm.state.value.entries.map { it.id })
            assertEquals("t5", vm.state.value.threadId)
            assertFalse(vm.state.value.sending)
            assertTrue(vm.state.value.attachments.isEmpty())
            assertEquals(listOf(sempRefItem()), chats.sent.single().context)
            assertNull(chats.sent.single().threadId)
            vm.close()
        }

    @Test fun `a message that is blank or sent while another is on its way is not sent`() = runTest(dispatcher) {
        val chats = chatWith(sempUser("m1", "Hi", T1))
        chats.sendAnswers += sempReceipt()
        chats.sendGate = CompletableDeferred()
        val vm = thread(chats, SempThreadStart.NEW)
        runCurrent()

        vm.onAction(SempThreadAction.Send("   "))
        vm.onAction(SempThreadAction.Send("One"))
        vm.onAction(SempThreadAction.Send("Two"))
        runCurrent()

        assertEquals(listOf("One"), chats.sent.map { it.text })
        chats.sendGate?.complete(Unit)
        runCurrent()
        vm.close()
    }

    @Test fun `a message the server refused stays as failed and can be retried or discarded`() = runTest(dispatcher) {
        val chats = chatWith(sempUser("m1", "Hi", T1))
        chats.sendAnswers += sempFailure<cz.semprec.app.domain.SempSendReceipt>(FailureKind.UNAVAILABLE)
        chats.sendAnswers += sempReceipt()
        val vm = thread(chats, SempThreadStart.NEW)
        runCurrent()

        vm.onAction(SempThreadAction.Send("Hi"))
        runCurrent()
        val failed = vm.state.value.entries.single()
        assertEquals(SempDelivery.FAILED, failed.delivery)
        assertEquals(FailureKind.UNAVAILABLE, failed.deliveryFailure)

        vm.onAction(SempThreadAction.ResolveUnsent(failed.id, retry = true))
        runCurrent()
        assertEquals(2, chats.sent.size)
        assertEquals(listOf("m1"), vm.state.value.entries.map { it.id })

        chats.sendAnswers.clear()
        chats.sendAnswers += sempFailure<cz.semprec.app.domain.SempSendReceipt>()
        vm.onAction(SempThreadAction.Send("Again"))
        runCurrent()
        val again = vm.state.value.entries.last()
        assertEquals(SempDelivery.FAILED, again.delivery)
        vm.onAction(SempThreadAction.ResolveUnsent(again.id, retry = false))
        assertEquals(listOf("m1"), vm.state.value.entries.map { it.id })
        vm.close()
    }

    @Test fun `a reply that is awaited is asked for again until it is done and then no more`() = runTest(dispatcher) {
        val waiting =
            sempConversationPage(sempUser("u1", "Hi", T1), sempReply("a1", "u1", T2, SempMessageStatus.QUEUED, null))
        val working =
            sempConversationPage(sempUser("u1", "Hi", T1), sempReply("a1", "u1", T2, SempMessageStatus.RUNNING, null))
        val done = sempConversationPage(sempUser("u1", "Hi", T1), sempReply("a1", "u1", T2))
        val chats = FakeSempRepository(messageAnswers = mutableListOf(waiting, working, done))
        val vm = thread(chats)
        runCurrent()
        assertEquals(SempReplyPhase.THINKING, vm.state.value.entries.last().replyPhase)

        advanceTimeBy(1_600)
        assertEquals(SempReplyPhase.WORKING, vm.state.value.entries.last().replyPhase)
        advanceTimeBy(1_600)
        assertEquals(SempReplyPhase.DONE, vm.state.value.entries.last().replyPhase)
        val calls = chats.messageCalls.size
        advanceTimeBy(60_000)
        assertEquals(calls, chats.messageCalls.size)
        vm.close()
    }

    @Test fun `closing the screen stops the asking`() = runTest(dispatcher) {
        val waiting =
            sempConversationPage(sempUser("u1", "Hi", T1), sempReply("a1", "u1", T2, SempMessageStatus.QUEUED, null))
        val chats = FakeSempRepository(messageAnswers = mutableListOf(waiting))
        val vm = thread(chats)
        runCurrent()
        val calls = chats.messageCalls.size

        vm.close()
        advanceTimeBy(30_000)

        assertEquals(calls, chats.messageCalls.size)
        vm.onAction(SempThreadAction.Retry)
        assertEquals(SempThreadPhase.READY, vm.state.value.phase)
    }

    @Test fun `clearing the store ends the thread like close does`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { thread(chatWith(sempUser("u1", "Hi", T1))) }
        runCurrent()

        store.clear()

        assertTrue(vm.isClosed)
    }

    @Test fun `a failed reply shows why and retry and regeneration ask the server and read again`() =
        runTest(dispatcher) {
            val failed = sempReply("a1", "u1", T2, SempMessageStatus.ERROR, null)
            val chats = chatWith(sempUser("u1", "Hi", T1), failed)
            val vm = thread(chats)
            runCurrent()
            assertEquals(SempReplyPhase.FAILED, vm.state.value.entries.last().replyPhase)
            assertFalse(vm.state.value.entries.last().canRegenerate)

            vm.onAction(SempThreadAction.AskAgain("a1", regenerate = false))
            runCurrent()
            vm.onAction(SempThreadAction.AskAgain("a1", regenerate = true))
            runCurrent()

            assertEquals(listOf("t1" to "a1"), chats.retries)
            assertEquals(listOf("t1" to "a1"), chats.regenerations)
            chats.retryAnswer = sempFailure(FailureKind.REJECTED)
            vm.onAction(SempThreadAction.AskAgain("a1", regenerate = false))
            runCurrent()
            assertTrue(vm.state.value.actionFailed)
            assertEquals(FailureKind.REJECTED, vm.state.value.actionFailure)
            vm.onAction(SempThreadAction.Dismiss.Failure)
            assertFalse(vm.state.value.actionFailed)
            vm.close()
        }

    @Test fun `the steps of a reply are read when it is opened and gone when it is closed`() = runTest(dispatcher) {
        val reply = sempReply("a1", "u1", T2, runId = "r1", steps = listOf(sempStep()))
        val runs = FakeSempRunRepository(
            stepsAnswer = RepositoryResult.Content(
                cz.semprec.app.domain.SempRunStepsPage(listOf(sempRunStep("s1")), null, false),
            ),
        )
        val vm = thread(chatWith(sempUser("u1", "Hi", T1), reply), runs = runs)
        runCurrent()

        vm.onAction(SempThreadAction.ToggleRun("a1"))
        assertEquals(SempStepsPhase.LOADING, vm.state.value.entries.last().run?.stepsPhase)
        runCurrent()
        val opened = vm.state.value.entries.last().run
        assertTrue(opened?.expanded == true)
        assertEquals(listOf("Step s1"), opened?.steps?.map { it.title })
        assertEquals(listOf(Triple<String, String?, String?>("r1", "a1", null)), runs.stepCalls)

        vm.onAction(SempThreadAction.ToggleRun("a1"))
        assertFalse(vm.state.value.entries.last().run?.expanded == true)
        vm.close()
    }

    @Test fun `steps that cannot be read are an error that can be opened again`() = runTest(dispatcher) {
        val reply = sempReply("a1", "u1", T2, runId = "r1", steps = listOf(sempStep()))
        val runs = FakeSempRunRepository(stepsAnswer = sempFailure())
        val vm = thread(chatWith(sempUser("u1", "Hi", T1), reply), runs = runs)
        runCurrent()

        vm.onAction(SempThreadAction.ToggleRun("a1"))
        runCurrent()

        assertEquals(SempStepsPhase.ERROR, vm.state.value.entries.last().run?.stepsPhase)
        vm.close()
    }

    @Test fun `a request waiting for approval is decided in the chat and followed until it ran`() =
        runTest(dispatcher) {
            val pending = SempStepApproval("pending", "not_approved", null)
            val reply = sempReply(
                "a1", "u1", T2, runId = "r1",
                steps = listOf(sempStep(SempStepStatus.WAIT, approvalId = "ap1", approval = pending)),
            )
            val approvals = FakeSempApprovalRepository()
            approvals.getAnswers += RepositoryResult.Content(sempApproval())
            val chats = chatWith(sempUser("u1", "Hi", T1), reply)
            val vm = thread(chats, approvals = approvals)
            runCurrent()
            val card = vm.state.value.entries.last().approvals.single()
            assertEquals(SempDecisionState.PENDING, card.decision)
            assertEquals("approval.itemDelete", card.descriptionKey)
            assertEquals(SempRunChipState.WAITING_APPROVAL, vm.state.value.entries.last().run?.state)

            approvals.getAnswers.clear()
            approvals.getAnswers += RepositoryResult.Content(
                sempApproval(status = SempApprovalStatus.APPROVED, execution = SempApprovalExecution.SUCCEEDED),
            )
            vm.onAction(SempThreadAction.Decide("ap1", approve = true))
            runCurrent()
            assertEquals(SempDecisionState.QUEUED, vm.state.value.entries.last().approvals.single().decision)

            advanceTimeBy(1_600)
            assertEquals(SempDecisionState.EXECUTED, vm.state.value.entries.last().approvals.single().decision)
            assertEquals(listOf("ap1" to true), approvals.decisions)
            vm.close()
        }

    @Test fun `a decision that did not reach the server leaves the request pending with the failure`() =
        runTest(dispatcher) {
            val pending = SempStepApproval("pending", "not_approved", null)
            val reply =
                sempReply(
                    "a1", "u1", T2,
                    steps = listOf(sempStep(SempStepStatus.WAIT, approvalId = "ap1", approval = pending)),
                )
            val approvals = FakeSempApprovalRepository()
            approvals.decideAnswer = sempFailure(FailureKind.UNAVAILABLE)
            val vm = thread(chatWith(sempUser("u1", "Hi", T1), reply), approvals = approvals)
            runCurrent()

            vm.onAction(SempThreadAction.Decide("ap1", approve = false))
            runCurrent()

            val card = vm.state.value.entries.last().approvals.single()
            assertEquals(SempDecisionState.PENDING, card.decision)
            assertTrue(card.decisionFailed)
            assertEquals(FailureKind.UNAVAILABLE, card.decisionFailure)
            vm.close()
        }

    @Test fun `older messages are added in front when asked for`() = runTest(dispatcher) {
        val chats = FakeSempRepository(
            messageAnswers = mutableListOf(
                sempConversationPage(sempUser("u2", "Newer", T3), next = "c1"),
                sempConversationPage(sempUser("u1", "Older", T1)),
            ),
        )
        val vm = thread(chats)
        runCurrent()
        assertTrue(vm.state.value.hasOlder)

        vm.onAction(SempThreadAction.LoadOlder)
        assertTrue(vm.state.value.loadingOlder)
        runCurrent()

        assertEquals(listOf("u1", "u2"), vm.state.value.entries.map { it.id })
        assertFalse(vm.state.value.hasOlder)
        assertEquals("t1" to "c1", chats.messageCalls.last())
        vm.close()
    }

    @Test fun `a tick thread shows its task and running it again waits for the run to end`() = runTest(dispatcher) {
        val tick = SempTickHeader("h1", "Weekly cleanup", true, "p1", "Diary", true)
        val chats = chatWith(sempUser("u1", "Hi", T1))
        chats.threadAnswers["t1"] = RepositoryResult.Content(sempThread(kind = SempThreadKind.TICK, tick = tick))
        val agent = FakeSempProjectAgentRepository()
        val vm = thread(chats, agent = agent)
        runCurrent()
        assertEquals(SempThreadType.TICK, vm.state.value.type)
        assertEquals("Weekly cleanup", vm.state.value.tick?.name)
        assertFalse(vm.state.value.tick?.running == true)

        chats.threadAnswers["t1"] = RepositoryResult.Content(
            sempThread(kind = SempThreadKind.TICK, tick = tick, activeRunId = "r2"),
        )
        vm.onAction(SempThreadAction.RunAgain)
        runCurrent()
        assertEquals(listOf("h1"), agent.ran)
        assertTrue(vm.state.value.tick?.running == true)

        chats.threadAnswers["t1"] = RepositoryResult.Content(sempThread(kind = SempThreadKind.TICK, tick = tick))
        advanceTimeBy(1_600)
        assertFalse(vm.state.value.tick?.running == true)
        vm.close()
    }

    @Test fun `a task that cannot be run is shown as failed and a disabled one is not run`() = runTest(dispatcher) {
        val tick = SempTickHeader("h1", "Weekly cleanup", true, "p1", null, true)
        val chats = chatWith(sempUser("u1", "Hi", T1))
        chats.threadAnswers["t1"] = RepositoryResult.Content(sempThread(kind = SempThreadKind.TICK, tick = tick))
        val agent = FakeSempProjectAgentRepository()
        agent.writeAnswer = sempFailure(FailureKind.REJECTED)
        val vm = thread(chats, agent = agent)
        runCurrent()

        vm.onAction(SempThreadAction.RunAgain)
        runCurrent()

        assertTrue(vm.state.value.tick?.triggerFailed == true)
        assertFalse(vm.state.value.tick?.running == true)
        vm.close()
    }

    @Test fun `the main chat shows the notice of a problem until it is closed`() = runTest(dispatcher) {
        val status = FakeSempStatusRepository(
            summaryAnswer = RepositoryResult.Content(
                SempStatusSummary(1, "p1", "Mail is not syncing", "Semp sees no new mail"),
            ),
        )
        val chats = chatWith(sempUser("u1", "Hi", T1))
        chats.threadsAnswer = RepositoryResult.Content(SempThreadsPage(listOf(sempThreadRow("t1")), null))
        val vm = thread(chats, SempThreadStart.LATEST, status = status)
        runCurrent()
        assertEquals("Mail is not syncing", vm.state.value.notice?.title)

        vm.onAction(SempThreadAction.Dismiss.Notice)
        runCurrent()
        assertNull(vm.state.value.notice)
        vm.close()
    }

    @Test fun `what the person opens is reported as an effect for the app to carry out`() = runTest(dispatcher) {
        val vm = thread(chatWith(sempUser("u1", "Hi", T1)))
        val effects = effectsOf(vm)
        runCurrent()

        vm.onAction(SempThreadAction.Open.Run("r1", "a1"))
        vm.onAction(SempThreadAction.Open.Change("i1", "tasks"))
        vm.onAction(SempThreadAction.Open.Approvals)
        vm.onAction(SempThreadAction.Open.Status)
        vm.onAction(SempThreadAction.Open.History)
        vm.onAction(SempThreadAction.Open.NewChat)
        runCurrent()

        assertEquals(
            listOf(
                SempThreadEffect.OpenRun("r1", "a1"),
                SempThreadEffect.OpenItem("i1", "tasks"),
                SempThreadEffect.OpenApprovals,
                SempThreadEffect.OpenStatus,
                SempThreadEffect.OpenHistory,
                SempThreadEffect.OpenNewChat,
            ),
            effects,
        )
        vm.close()
    }

    @Test fun `a staged object can be taken back and a closed thread ignores actions`() = runTest(dispatcher) {
        val vm = thread(chatWith(sempUser("u1", "Hi", T1)))
        runCurrent()
        session.stage(SempTarget(SempTargetKind.TASK, "Send invoice", null, "i1", "d1", null, null))
        runCurrent()
        val key = vm.state.value.attachments.single().key

        vm.onAction(SempThreadAction.Dismiss.Attachment(key))
        runCurrent()
        assertTrue(vm.state.value.attachments.isEmpty())

        vm.close()
        vm.onAction(SempThreadAction.Send("late"))
        runCurrent()
        assertTrue(vm.state.value.entries.none { it.text == "late" })
    }

    @Test fun `a thread read late after a retry does not replace the newer answer`() = runTest(dispatcher) {
        val chats = FakeSempRepository(
            messageAnswers = mutableListOf(
                sempConversationPage(sempUser("old", "Superseded", T1)),
                sempConversationPage(sempUser("new", "Current", T2)),
            ),
        )
        val gate = CompletableDeferred<Unit>()
        chats.threadGate = gate
        val vm = thread(chats)
        runCurrent()
        vm.onAction(SempThreadAction.Retry)
        runCurrent()

        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf("new"), vm.state.value.entries.map { it.id })
        assertEquals(SempThreadPhase.READY, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a thread read late after the screen was closed shows nothing`() = runTest(dispatcher) {
        val chats = chatWith(sempUser("u1", "Hi", T1))
        val gate = CompletableDeferred<Unit>()
        chats.threadGate = gate
        val vm = thread(chats)
        runCurrent()

        vm.close()
        gate.complete(Unit)
        runCurrent()

        assertEquals(SempThreadPhase.LOADING, vm.state.value.phase)
        assertTrue(vm.state.value.entries.isEmpty())
    }
}
