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
class MailFoldersViewModelTest : MainDispatcherTest() {
    private fun viewModel(
        mail: ScriptedMailRepository = ScriptedMailRepository(),
        mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository(),
    ) = MailViewModelFactory(mail, mail, ScriptedMailDraftRepository(), mailboxes, mail, sync = sync).foldersViewModel()

    private val sync = SyncChanges()

    @Test fun `shows the smart boxes and every account with its folders`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(MailFoldersPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(MailFoldersPhase.CONTENT, state.phase)
        assertEquals(Triple(5, 2, 1), Triple(state.unreadInbox, state.flagged, state.sempDrafts))
        val account = state.accounts.single()
        assertEquals("m1", account.id)
        assertEquals("me@gmail.com", account.address)
        assertEquals(MailAccountStatus.OK, account.status)
        assertEquals(MailFolderItem("f1", "Inbox", "inbox", 3), account.folders.single())
        assertFalse(account.foldersFailed)
        vm.close()
    }

    @Test fun `the status of an account says what its sync is doing`() = runTest(dispatcher) {
        val accounts = listOf(
            mailAccount("a", MailSyncStatus.OK),
            mailAccount("b", MailSyncStatus.OK, initial = true),
            mailAccount("c", MailSyncStatus.NEVER),
            mailAccount("d", MailSyncStatus.ERROR),
            mailAccount("e", MailSyncStatus.NEEDS_REAUTHORIZATION),
        )
        val vm = viewModel(mailboxes = ScriptedMailboxRepository(list = MailCall(mailContent(accounts))))
        runCurrent()
        assertEquals(
            listOf(
                MailAccountStatus.OK,
                MailAccountStatus.SYNCING,
                MailAccountStatus.SYNCING,
                MailAccountStatus.ERROR,
                MailAccountStatus.NEEDS_REAUTHORIZATION,
            ),
            vm.state.value.accounts.map { it.status },
        )
        vm.close()
    }

    @Test fun `the screen is read again with its folders when the server reports a mail change`() =
        runTest(dispatcher) {
            val mailboxes = ScriptedMailboxRepository(
                list = MailCall(
                    mailContent(listOf(mailAccount("a", initial = true))),
                    mailContent(listOf(mailAccount("a"))),
                ),
            )
            val vm = viewModel(mailboxes = mailboxes)
            runCurrent()
            assertEquals(MailAccountStatus.SYNCING, vm.state.value.accounts.single().status)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, mailboxes.list.count)

            sync.raise(setOf(SyncTopic.CALENDAR))
            runCurrent()
            assertEquals(1, mailboxes.list.count)
            sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
            runCurrent()
            assertEquals(2, mailboxes.list.count)
            assertEquals(2, mailboxes.folders.count)
            assertEquals(MailAccountStatus.OK, vm.state.value.accounts.single().status)
            vm.close()
        }

    @Test fun `an account whose folders fail stays listed without them`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(folders = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(mailboxes = boxes)
        runCurrent()
        val account = vm.state.value.accounts.single()
        assertEquals(emptyList(), account.folders)
        assertTrue(account.foldersFailed)
        assertEquals(MailFoldersPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `failing accounts or summary are an error with their kind and retry recovers`() = runTest(dispatcher) {
        val accountsFail = viewModel(
            mailboxes = ScriptedMailboxRepository(
                list = MailCall(mailFailure(FailureKind.UNAUTHORIZED), mailContent(listOf(mailAccount()))),
            ),
        )
        val summaryFails = viewModel(ScriptedMailRepository(summary = MailCall(mailFailure(FailureKind.UNAVAILABLE))))
        val crashed = viewModel(ScriptedMailRepository(summary = MailCall(crashes())))
        runCurrent()
        assertEquals(FailureKind.UNAUTHORIZED, accountsFail.state.value.failure)
        assertEquals(FailureKind.UNAVAILABLE, summaryFails.state.value.failure)
        assertEquals(MailFoldersPhase.ERROR, crashed.state.value.phase)
        assertNull(crashed.state.value.failure)
        accountsFail.onAction(MailFoldersAction.Retry)
        runCurrent()
        assertEquals(MailFoldersPhase.CONTENT, accountsFail.state.value.phase)
        accountsFail.close()
        summaryFails.close()
        crashed.close()
    }

    @Test fun `a refresh keeps the content and a failed one leaves it as it was`() = runTest(dispatcher) {
        val mail =
            ScriptedMailRepository(summary = MailCall(mailContent(mailSummary()), mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailFoldersAction.Refresh)
        assertTrue(vm.state.value.refreshing)
        runCurrent()
        assertFalse(vm.state.value.refreshing)
        assertEquals(5, vm.state.value.unreadInbox)
        vm.close()
    }

    @Test fun `an account folds and unfolds and stays folded through a reload`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.onAction(MailFoldersAction.ToggleAccount("m1"))
        assertTrue(vm.state.value.accounts.single().collapsed)
        vm.onAction(MailFoldersAction.Refresh)
        runCurrent()
        assertTrue(vm.state.value.accounts.single().collapsed)
        vm.onAction(MailFoldersAction.ToggleAccount("m1"))
        assertFalse(vm.state.value.accounts.single().collapsed)
        vm.close()
    }

    @Test fun `opening a row raises the list it stands for`() = runTest(dispatcher) {
        val vm = viewModel()
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailFoldersAction.OpenBox(MailListBox.INBOX))
        vm.onAction(MailFoldersAction.OpenBox(MailListBox.FLAGGED))
        vm.onAction(MailFoldersAction.OpenBox(MailListBox.SEMP_DRAFTS))
        vm.onAction(MailFoldersAction.OpenFolder("m1", "f1"))
        vm.onAction(MailFoldersAction.OpenFolder("m1", "unknown"))
        vm.onAction(MailFoldersAction.Compose)
        vm.onAction(MailFoldersAction.OpenAccounts)
        runCurrent()
        assertEquals(
            listOf(
                MailFoldersEffect.OpenList(MailListStart(box = MailListBox.INBOX), null),
                MailFoldersEffect.OpenList(MailListStart(box = MailListBox.FLAGGED), null),
                MailFoldersEffect.OpenList(MailListStart(box = MailListBox.SEMP_DRAFTS), null),
                MailFoldersEffect.OpenList(MailListStart(mailboxId = "m1", folderId = "f1"), "Inbox"),
                MailFoldersEffect.OpenList(MailListStart(mailboxId = "m1", folderId = "unknown"), null),
                MailFoldersEffect.Compose,
                MailFoldersEffect.OpenAccounts,
            ),
            effects,
        )
        vm.close()
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(list = MailCall(neverAnswers()))
        val vm = viewModel(mailboxes = boxes)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(MailFoldersAction.Retry)
        vm.onAction(MailFoldersAction.Compose)
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.list.cancellations)
        assertEquals(1, boxes.list.count)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val boxes = ScriptedMailboxRepository(list = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(mailboxes = boxes) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.list.cancellations)
    }
}
