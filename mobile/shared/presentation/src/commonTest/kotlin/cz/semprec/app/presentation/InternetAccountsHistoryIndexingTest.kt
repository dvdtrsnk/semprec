package cz.semprec.app.presentation

import cz.semprec.app.domain.IndexMailHistory
import cz.semprec.app.domain.MailConnectOutcome
import cz.semprec.app.domain.MailConnectRefusal
import cz.semprec.app.domain.SyncChanges
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The history indexing of an account the accounts list connected with a password. */
@OptIn(ExperimentalCoroutinesApi::class)
class InternetAccountsHistoryIndexingTest : MainDispatcherTest() {
    private fun viewModel(
        history: IndexMailHistory,
        mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository(),
    ) = InternetAccountViewModelFactory(ScriptedInternetAccountRepository(), mailboxes, history, SyncChanges())
        .accountsViewModel()

    private fun icloud(address: String = "me@icloud.com") =
        InternetAccountsAction.Connect(InternetPasswordProvider.ICLOUD, address, "pass", "", "", "")

    @Test fun `a connected password account is indexed with the typed password and shows how far it got`() =
        runTest(dispatcher) {
            val history = ScriptedMailHistory()
            val imap = ScriptedHistoryImap()
            history.uploadGate = CompletableDeferred()
            val boxes = ScriptedMailboxRepository(connect = MailCall(mailContent(MailConnectOutcome.Connected("new"))))
            val vm = viewModel(indexHistory(history, imap), boxes)
            runCurrent()
            vm.onAction(
                InternetAccountsAction.Connect(
                    InternetPasswordProvider.OTHER, "me@firma.cz", "heslo", " IMAP.Firma.cz. ", "smtp.firma.cz", "",
                ),
            )
            runCurrent()

            assertEquals(InternetHistoryIndexing("new", 0, 1, 0), vm.state.value.historyIndexing)
            val login = imap.logins.single()
            assertEquals(
                listOf("imap.firma.cz", "me@firma.cz", "heslo"),
                listOf(login.host, login.username, login.password),
            )
            assertTrue(vm.holdsHistoryLogins)
            history.uploadGate.complete(Unit)
            runCurrent()

            assertEquals(listOf(1L), history.uploaded.single().second.messages.map { it.uid })
            assertEquals(listOf("lease-new"), history.released)
            assertNull(vm.state.value.historyIndexing)
            assertFalse(vm.holdsHistoryLogins)
            assertEquals(0, imap.open)
            vm.close()
        }

    @Test fun `an icloud account is indexed on the icloud imap server`() = runTest(dispatcher) {
        val imap = ScriptedHistoryImap()
        val vm = viewModel(indexHistory(ScriptedMailHistory(), imap))
        runCurrent()
        vm.onAction(icloud())
        runCurrent()
        assertEquals(listOf("imap.mail.me.com"), imap.logins.map { it.host })
        vm.close()
    }

    @Test fun `accounts connected one after another are indexed one at a time over one connection`() =
        runTest(dispatcher) {
            val history = ScriptedMailHistory()
            val imap = ScriptedHistoryImap()
            history.uploadGate = CompletableDeferred()
            val boxes = ScriptedMailboxRepository(
                connect = MailCall(
                    mailContent(MailConnectOutcome.Connected("first")),
                    mailContent(MailConnectOutcome.Connected("second")),
                ),
            )
            val vm = viewModel(indexHistory(history, imap), boxes)
            runCurrent()
            vm.onAction(icloud("one@icloud.com"))
            runCurrent()
            vm.onAction(icloud("two@icloud.com"))
            runCurrent()

            assertEquals("first", vm.state.value.historyIndexing?.accountId)
            assertEquals(listOf("one@icloud.com"), imap.logins.map { it.username })
            history.uploadGate.complete(Unit)
            runCurrent()

            assertEquals(listOf("one@icloud.com", "two@icloud.com"), imap.logins.map { it.username })
            assertEquals(listOf("first", "second"), history.uploaded.map { it.first })
            assertEquals(1, imap.mostOpen)
            assertNull(vm.state.value.historyIndexing)
            vm.close()
        }

    @Test fun `closing the screen ends the indexing and releases the lease and every held password`() =
        runTest(dispatcher) {
            val history = ScriptedMailHistory()
            val imap = ScriptedHistoryImap()
            history.uploadGate = CompletableDeferred()
            val boxes = ScriptedMailboxRepository(
                connect = MailCall(
                    mailContent(MailConnectOutcome.Connected("first")),
                    mailContent(MailConnectOutcome.Connected("second")),
                ),
            )
            val vm = viewModel(indexHistory(history, imap), boxes)
            runCurrent()
            vm.onAction(icloud("one@icloud.com"))
            runCurrent()
            vm.onAction(icloud("two@icloud.com"))
            runCurrent()
            assertTrue(vm.holdsHistoryLogins)

            vm.close()
            runCurrent()

            assertFalse(vm.holdsHistoryLogins)
            assertNull(vm.state.value.historyIndexing)
            assertEquals(listOf("lease-first"), history.released)
            assertEquals(0, imap.open)
            assertEquals(listOf("one@icloud.com"), imap.logins.map { it.username })
            assertTrue(history.uploaded.isEmpty())
        }

    @Test fun `a refused connect indexes nothing`() = runTest(dispatcher) {
        val history = ScriptedMailHistory()
        val refused: MailConnectOutcome = MailConnectOutcome.Refused(MailConnectRefusal.WRONG_CREDENTIALS)
        val boxes = ScriptedMailboxRepository(connect = MailCall(mailContent(refused)))
        val vm = viewModel(indexHistory(history), boxes)
        runCurrent()
        vm.onAction(icloud())
        runCurrent()
        assertTrue(history.claimed.isEmpty())
        assertNull(vm.state.value.historyIndexing)
        vm.close()
    }
}
