package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
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
class MailAccountsViewModelTest : MainDispatcherTest() {
    private val sync = SyncChanges()

    private fun viewModel(mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository()) =
        MailViewModelFactory(ScriptedMailRepository(), ScriptedMailDraftRepository(), mailboxes, sync = sync)
            .accountsViewModel()

    private fun icloud(address: String = "me@icloud.com", password: String = "pass") =
        MailAccountsAction.Connect(MailConnectKind.ICLOUD, address, password, "", "")

    @Test fun `lists the accounts with their status`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(
            list = MailCall(
                mailContent(listOf(mailAccount("a"), mailAccount("b", MailSyncStatus.NEEDS_REAUTHORIZATION))),
            ),
        )
        val vm = viewModel(boxes)
        assertEquals(MailAccountsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(
            listOf(
                MailAccountItem("a", "Gmail", "me@gmail.com", "gmail", MailAccountStatus.OK),
                MailAccountItem("b", "Gmail", "me@gmail.com", "gmail", MailAccountStatus.NEEDS_REAUTHORIZATION),
            ),
            vm.state.value.accounts,
        )
        vm.close()
    }

    @Test fun `a mail change the server reports reads the list again and a timer does not`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(
            list = MailCall(
                mailContent(listOf(mailAccount("a", MailSyncStatus.NEVER))),
                mailContent(listOf(mailAccount("a", initial = true))),
                mailContent(listOf(mailAccount("a"))),
            ),
        )
        val vm = viewModel(boxes)
        runCurrent()
        assertEquals(MailAccountStatus.SYNCING, vm.state.value.accounts.single().status)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, boxes.list.count)

        sync.raise(setOf(SyncTopic.CALENDAR, SyncTopic.INVITATIONS))
        runCurrent()
        assertEquals(1, boxes.list.count)
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(2, boxes.list.count)
        assertEquals(MailAccountStatus.SYNCING, vm.state.value.accounts.single().status)
        assertFalse(vm.state.value.refreshing)
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(3, boxes.list.count)
        assertEquals(MailAccountStatus.OK, vm.state.value.accounts.single().status)

        vm.close()
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(3, boxes.list.count)
    }

    @Test fun `failures are an error and retry recovers and a failed refresh keeps the list`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(
            list = MailCall(
                mailFailure(FailureKind.UNAVAILABLE),
                mailContent(listOf(mailAccount())),
                mailFailure(FailureKind.UNAVAILABLE),
            ),
        )
        val vm = viewModel(boxes)
        val crashed = viewModel(ScriptedMailboxRepository(list = MailCall(crashes())))
        runCurrent()
        assertEquals(MailAccountsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        assertNull(crashed.state.value.failure)
        vm.onAction(MailAccountsAction.Retry)
        runCurrent()
        assertEquals(MailAccountsPhase.CONTENT, vm.state.value.phase)
        vm.onAction(MailAccountsAction.Refresh)
        assertTrue(vm.state.value.refreshing)
        runCurrent()
        assertFalse(vm.state.value.refreshing)
        assertEquals(1, vm.state.value.accounts.size)
        vm.close()
        crashed.close()
    }

    @Test fun `a refresh without a list is a retry`() = runTest(dispatcher) {
        val boxes =
            ScriptedMailboxRepository(
                list = MailCall(mailFailure(FailureKind.UNAVAILABLE), mailContent(listOf(mailAccount()))),
            )
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(MailAccountsAction.Refresh)
        assertEquals(MailAccountsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(MailAccountsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `opening an account raises it`() = runTest(dispatcher) {
        val vm = viewModel()
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailAccountsAction.Open("m1"))
        runCurrent()
        assertEquals(listOf<MailAccountsEffect>(MailAccountsEffect.OpenAccount("m1")), effects)
        vm.close()
    }

    @Test fun `an icloud mailbox is connected without servers and the list loads again`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(icloud(" me@icloud.com "))
        assertTrue(vm.state.value.connecting)
        vm.onAction(icloud())
        runCurrent()
        assertEquals(
            listOf(MailPasswordAccount(MailPasswordProvider.ICLOUD, "me@icloud.com", "pass", null, null)),
            boxes.connect.asked,
        )
        assertFalse(vm.state.value.connecting)
        assertEquals(listOf<MailAccountsEffect>(MailAccountsEffect.Connected), effects)
        assertEquals(2, boxes.list.count)
        vm.close()
    }

    @Test fun `a generic mailbox needs both servers and carries them trimmed`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(MailAccountsAction.Connect(MailConnectKind.GENERIC, "me@firma.cz", "pw", "imap.firma.cz", " "))
        assertEquals(MailConnectFailure.INVALID_INPUT, vm.state.value.connectFailure)
        val form = MailAccountsAction.Connect(
            MailConnectKind.GENERIC,
            "me@firma.cz",
            "pw",
            " imap.firma.cz ",
            "smtp.firma.cz",
        )
        vm.onAction(form)
        runCurrent()
        assertEquals(
            MailPasswordAccount(MailPasswordProvider.GENERIC, "me@firma.cz", "pw", "imap.firma.cz", "smtp.firma.cz"),
            boxes.connect.asked.single(),
        )
        assertNull(vm.state.value.connectFailure)
        vm.close()
    }

    @Test fun `input that is no address or has no password is invalid and nothing is sent`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(icloud(address = "nobody"))
        assertEquals(MailConnectFailure.INVALID_INPUT, vm.state.value.connectFailure)
        vm.onAction(MailAccountsAction.DismissConnectFailure)
        assertNull(vm.state.value.connectFailure)
        vm.onAction(icloud(password = ""))
        assertEquals(MailConnectFailure.INVALID_INPUT, vm.state.value.connectFailure)
        assertEquals(0, boxes.connect.count)
        vm.close()
    }

    @Test fun `a refused or unreachable login says why and keeps the form`() = runTest(dispatcher) {
        val refused = ScriptedMailboxRepository(connect = MailCall(mailFailure(FailureKind.REJECTED)))
        val down = ScriptedMailboxRepository(connect = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val odd = ScriptedMailboxRepository(connect = MailCall(mailFailure(FailureKind.UNAUTHORIZED)))
        val crashed = ScriptedMailboxRepository(connect = MailCall(crashes()))
        val models = listOf(refused, down, odd, crashed).map { viewModel(it) }
        val effects = models.map { collectEffects(it) }
        runCurrent()
        models.forEach { it.onAction(icloud()) }
        runCurrent()
        assertEquals(
            listOf(
                MailConnectFailure.REFUSED,
                MailConnectFailure.UNAVAILABLE,
                MailConnectFailure.UNEXPECTED,
                MailConnectFailure.UNEXPECTED,
            ),
            models.map { it.state.value.connectFailure },
        )
        assertTrue(models.none { it.state.value.connecting })
        assertTrue(effects.all { it.isEmpty() })
        models.forEach { it.close() }
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(list = MailCall(neverAnswers()))
        val vm = viewModel(boxes)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(icloud())
        vm.onAction(MailAccountsAction.Retry)
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.list.cancellations)
        assertEquals(0, boxes.connect.count)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val boxes = ScriptedMailboxRepository(list = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(boxes) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.list.cancellations)
    }
}
