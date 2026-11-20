package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class MailAccountViewModelTest : MainDispatcherTest() {
    private val sync = SyncChanges()

    private fun viewModel(mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository()) =
        MailViewModelFactory(ScriptedMailRepository(), ScriptedMailDraftRepository(), mailboxes, sync = sync)
            .accountViewModel("m1")

    private fun mailChanged() = sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))

    @Test fun `shows the account with what its sync did`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(
            one = MailCall(mailContent(mailAccount(status = MailSyncStatus.NEEDS_REAUTHORIZATION))),
        )
        val vm = viewModel(boxes)
        assertEquals(MailAccountPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val account = vm.state.value.account
        assertEquals(MailAccountPhase.CONTENT, vm.state.value.phase)
        assertEquals("Gmail", account?.name)
        assertEquals(MailAccountStatus.NEEDS_REAUTHORIZATION, account?.status)
        assertEquals("2026-10-19T09:12:00.000Z", account?.failingSince)
        assertEquals(3, account?.connectionLimit)
        assertEquals(1, account?.autonomousSendProjectCount)
        assertEquals(listOf("m1"), boxes.one.asked)
        vm.close()
    }

    @Test fun `a mail change the server reports reads the status again and keeps a name changed meanwhile`() =
        runTest(dispatcher) {
            val boxes = ScriptedMailboxRepository(
                one = MailCall(
                    mailContent(mailAccount(initial = true).copy(syncedMessageCount = 10, lastSuccessfulSyncAt = null)),
                    mailFailure(FailureKind.UNAVAILABLE),
                    mailContent(mailAccount(initial = true).copy(name = "Server name", syncedMessageCount = 20)),
                    mailContent(mailAccount()),
                ),
            )
            val vm = viewModel(boxes)
            runCurrent()
            assertEquals(MailAccountStatus.SYNCING, vm.state.value.account?.status)
            assertEquals(10, vm.state.value.account?.syncedMessageCount)
            vm.onAction(MailAccountAction.Rename("Work"))
            runCurrent()
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, boxes.one.count)

            sync.raise(setOf(SyncTopic.CALENDAR))
            runCurrent()
            assertEquals(1, boxes.one.count)
            mailChanged()
            runCurrent()
            assertEquals(10, vm.state.value.account?.syncedMessageCount)
            assertEquals(MailAccountPhase.CONTENT, vm.state.value.phase)
            mailChanged()
            runCurrent()
            assertEquals(20, vm.state.value.account?.syncedMessageCount)
            assertEquals("2026-10-19T08:12:00.000Z", vm.state.value.account?.lastSuccessfulSyncAt)
            assertEquals("Work", vm.state.value.account?.name)
            mailChanged()
            runCurrent()
            assertEquals(MailAccountStatus.OK, vm.state.value.account?.status)
            assertEquals("Work", vm.state.value.account?.name)
            assertEquals(4, boxes.one.count)
            vm.close()
        }

    @Test fun `an error shows its kind and retry loads again`() = runTest(dispatcher) {
        val boxes =
            ScriptedMailboxRepository(one = MailCall(mailFailure(FailureKind.NOT_FOUND), mailContent(mailAccount())))
        val vm = viewModel(boxes)
        val crashed = viewModel(ScriptedMailboxRepository(one = MailCall(crashes())))
        runCurrent()
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)
        assertNull(crashed.state.value.failure)
        assertEquals(MailAccountPhase.ERROR, crashed.state.value.phase)
        vm.onAction(MailAccountAction.Retry)
        runCurrent()
        assertEquals(MailAccountPhase.CONTENT, vm.state.value.phase)
        vm.close()
        crashed.close()
    }

    @Test fun `a new name is shown at once and written and a blank or unchanged one is ignored`() =
        runTest(dispatcher) {
            val boxes = ScriptedMailboxRepository()
            val vm = viewModel(boxes)
            runCurrent()
            vm.onAction(MailAccountAction.Rename("  "))
            vm.onAction(MailAccountAction.Rename("Gmail"))
            vm.onAction(MailAccountAction.Rename(" Osobní "))
            assertEquals("Osobní", vm.state.value.account?.name)
            runCurrent()
            assertEquals(listOf("m1" to "Osobní"), boxes.rename.asked)
            assertFalse(vm.state.value.actionFailed)
            vm.close()
        }

    @Test fun `a refused name is put back and says so`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(rename = MailCall(mailFailure(FailureKind.REJECTED)))
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(MailAccountAction.Rename("Osobní"))
        runCurrent()
        assertEquals("Gmail", vm.state.value.account?.name)
        assertTrue(vm.state.value.actionFailed)
        vm.onAction(MailAccountAction.DismissFailure)
        assertFalse(vm.state.value.actionFailed)
        vm.close()
    }

    @Test fun `the connection limit steps within one and fifteen and is written`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(MailAccountAction.StepConnectionLimit(1))
        assertEquals(4, vm.state.value.account?.connectionLimit)
        vm.onAction(MailAccountAction.StepConnectionLimit(100))
        assertEquals(15, vm.state.value.account?.connectionLimit)
        vm.onAction(MailAccountAction.StepConnectionLimit(1))
        vm.onAction(MailAccountAction.StepConnectionLimit(-100))
        assertEquals(1, vm.state.value.account?.connectionLimit)
        vm.onAction(MailAccountAction.StepConnectionLimit(-1))
        runCurrent()
        assertEquals(listOf("m1" to 4, "m1" to 15, "m1" to 1), boxes.limit.asked)
        vm.close()
    }

    @Test fun `a refused limit is put back and a mailbox without the setting ignores the step`() = runTest(dispatcher) {
        val refused = ScriptedMailboxRepository(limit = MailCall(mailFailure(FailureKind.REJECTED)))
        val gmailApi = ScriptedMailboxRepository(one = MailCall(mailContent(mailAccount(limitApplies = false))))
        val first = viewModel(refused)
        val second = viewModel(gmailApi)
        runCurrent()
        first.onAction(MailAccountAction.StepConnectionLimit(1))
        second.onAction(MailAccountAction.StepConnectionLimit(1))
        runCurrent()
        assertEquals(3, first.state.value.account?.connectionLimit)
        assertTrue(first.state.value.actionFailed)
        assertEquals(0, gmailApi.limit.count)
        first.close()
        second.close()
    }

    @Test fun `removal reads its impact and waits for the answer`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailAccountAction.RequestRemoval)
        assertEquals(MailRemovalPhase.LOADING_IMPACT, vm.state.value.removal)
        runCurrent()
        assertEquals(MailRemovalPhase.CONFIRMING, vm.state.value.removal)
        assertEquals(MailRemovalImpactItem(120, 2, 50, 7), vm.state.value.impact)
        assertEquals(0, boxes.remove.count)
        vm.onAction(MailAccountAction.CancelRemoval)
        assertEquals(MailRemovalPhase.IDLE, vm.state.value.removal)
        assertNull(vm.state.value.impact)
        assertEquals(emptyList(), effects)
        vm.close()
    }

    @Test fun `a confirmed removal removes the mailbox and closes the screen`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailAccountAction.ConfirmRemoval)
        assertEquals(0, boxes.remove.count)
        vm.onAction(MailAccountAction.RequestRemoval)
        runCurrent()
        vm.onAction(MailAccountAction.ConfirmRemoval)
        assertEquals(MailRemovalPhase.REMOVING, vm.state.value.removal)
        runCurrent()
        assertEquals(listOf("m1"), boxes.remove.asked)
        assertEquals(listOf<MailAccountEffect>(MailAccountEffect.Removed), effects)
        vm.close()
    }

    @Test fun `a refused removal returns to the question and an impact that fails stays idle`() = runTest(dispatcher) {
        val refused = ScriptedMailboxRepository(remove = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val noImpact = ScriptedMailboxRepository(impact = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val first = viewModel(refused)
        val second = viewModel(noImpact)
        runCurrent()
        first.onAction(MailAccountAction.RequestRemoval)
        second.onAction(MailAccountAction.RequestRemoval)
        runCurrent()
        first.onAction(MailAccountAction.ConfirmRemoval)
        runCurrent()
        assertEquals(MailRemovalPhase.CONFIRMING, first.state.value.removal)
        assertTrue(first.state.value.actionFailed)
        assertEquals(MailRemovalPhase.IDLE, second.state.value.removal)
        assertTrue(second.state.value.actionFailed)
        first.close()
        second.close()
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(one = MailCall(neverAnswers()))
        val vm = viewModel(boxes)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(MailAccountAction.Retry)
        vm.onAction(MailAccountAction.RequestRemoval)
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.one.cancellations)
        assertEquals(1, boxes.one.count)
        assertEquals(0, boxes.impact.count)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val boxes = ScriptedMailboxRepository(one = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(boxes) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.one.cancellations)
    }
}
