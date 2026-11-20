package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
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
class InternetAccountsViewModelTest : MainDispatcherTest() {
    private val sync = SyncChanges()

    private fun viewModel(
        mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository(),
        accounts: ScriptedInternetAccountRepository = ScriptedInternetAccountRepository(),
    ) = InternetAccountViewModelFactory(accounts, mailboxes, sync).accountsViewModel()

    private fun viewModel(accounts: ScriptedInternetAccountRepository) =
        viewModel(ScriptedMailboxRepository(), accounts)

    private fun icloud(address: String = "me@icloud.com", password: String = "pass") =
        InternetAccountsAction.Connect(InternetPasswordProvider.ICLOUD, address, password, "", "", "")

    private fun item(id: String, mail: InternetServiceStatus, calendars: InternetServiceStatus) =
        InternetAccountItem(id, "Gmail", "me@gmail.com", "gmail", mail, calendars)

    @Test fun `lists the accounts with the status of each service`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository(
            list = MailCall(
                mailContent(
                    listOf(
                        internetAccount("a"),
                        internetAccount("b", MailSyncStatus.NEEDS_REAUTHORIZATION, calendars = true),
                        internetAccount("c", mail = false, calendars = true, calendarStatus = CalendarSyncStatus.OK),
                        internetAccount(
                            "d",
                            MailSyncStatus.NEVER,
                            calendars = true,
                            calendarStatus = CalendarSyncStatus.NEEDS_CONSENT,
                        ),
                        internetAccount(
                            "e",
                            MailSyncStatus.ERROR,
                            calendars = true,
                            calendarStatus = CalendarSyncStatus.NEVER,
                        ),
                        internetAccount("f", calendars = true, calendarStatus = CalendarSyncStatus.ERROR),
                        internetAccount(
                            "g",
                            calendars = true,
                            calendarStatus = CalendarSyncStatus.NEEDS_REAUTHORIZATION,
                        ),
                        // The switch is the truth: a status the server still holds for a switched-off service is off,
                        // and a switched-on service the server reports as off has not started yet.
                        internetAccount("h", calendars = false, calendarStatus = CalendarSyncStatus.OK),
                        internetAccount("i", calendars = true, calendarStatus = CalendarSyncStatus.OFF),
                    ),
                ),
            ),
        )
        val vm = viewModel(accounts)
        assertEquals(InternetAccountsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(
            listOf(
                item("a", InternetServiceStatus.OK, InternetServiceStatus.OFF),
                item("b", InternetServiceStatus.NEEDS_REAUTHORIZATION, InternetServiceStatus.PENDING),
                item("c", InternetServiceStatus.OFF, InternetServiceStatus.OK),
                item("d", InternetServiceStatus.SYNCING, InternetServiceStatus.NEEDS_CONSENT),
                item("e", InternetServiceStatus.ERROR, InternetServiceStatus.SYNCING),
                item("f", InternetServiceStatus.OK, InternetServiceStatus.ERROR),
                item("g", InternetServiceStatus.OK, InternetServiceStatus.NEEDS_REAUTHORIZATION),
                item("h", InternetServiceStatus.OK, InternetServiceStatus.OFF),
                item("i", InternetServiceStatus.OK, InternetServiceStatus.PENDING),
            ),
            vm.state.value.accounts,
        )
        vm.close()
    }

    @Test fun `a mail change the server reports reads the list again and a timer does not`() = runTest(dispatcher) {
        val boxes = ScriptedInternetAccountRepository(
            list = MailCall(
                mailContent(listOf(internetAccount("a", MailSyncStatus.NEVER))),
                mailContent(listOf(internetAccount("a", initial = true))),
                mailContent(listOf(internetAccount("a"))),
            ),
        )
        val vm = viewModel(boxes)
        runCurrent()
        assertEquals(InternetServiceStatus.SYNCING, vm.state.value.accounts.single().mail)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, boxes.list.count)

        sync.raise(setOf(SyncTopic.CALENDAR, SyncTopic.INVITATIONS))
        runCurrent()
        assertEquals(1, boxes.list.count)
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(2, boxes.list.count)
        assertEquals(InternetServiceStatus.SYNCING, vm.state.value.accounts.single().mail)
        assertFalse(vm.state.value.refreshing)
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(3, boxes.list.count)
        assertEquals(InternetServiceStatus.OK, vm.state.value.accounts.single().mail)

        vm.close()
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(3, boxes.list.count)
    }

    @Test fun `failures are an error and retry recovers and a failed refresh keeps the list`() = runTest(dispatcher) {
        val boxes = ScriptedInternetAccountRepository(
            list = MailCall(
                mailFailure(FailureKind.UNAVAILABLE),
                mailContent(listOf(internetAccount())),
                mailFailure(FailureKind.UNAVAILABLE),
            ),
        )
        val vm = viewModel(boxes)
        val crashed = viewModel(ScriptedInternetAccountRepository(list = MailCall(crashes())))
        runCurrent()
        assertEquals(InternetAccountsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        assertNull(crashed.state.value.failure)
        vm.onAction(InternetAccountsAction.Retry)
        runCurrent()
        assertEquals(InternetAccountsPhase.CONTENT, vm.state.value.phase)
        vm.onAction(InternetAccountsAction.Refresh)
        assertTrue(vm.state.value.refreshing)
        runCurrent()
        assertFalse(vm.state.value.refreshing)
        assertEquals(1, vm.state.value.accounts.size)
        vm.close()
        crashed.close()
    }

    @Test fun `a refresh without a list is a retry`() = runTest(dispatcher) {
        val boxes =
            ScriptedInternetAccountRepository(
                list = MailCall(mailFailure(FailureKind.UNAVAILABLE), mailContent(listOf(internetAccount()))),
            )
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(InternetAccountsAction.Refresh)
        assertEquals(InternetAccountsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(InternetAccountsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `opening an account raises it`() = runTest(dispatcher) {
        val vm = viewModel()
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(InternetAccountsAction.Open("m1"))
        runCurrent()
        assertEquals(listOf<InternetAccountsEffect>(InternetAccountsEffect.OpenAccount("m1")), effects)
        vm.close()
    }

    @Test fun `an icloud account is connected without servers and the list loads again`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val accounts = ScriptedInternetAccountRepository()
        val vm = viewModel(boxes, accounts)
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
        assertEquals(listOf<InternetAccountsEffect>(InternetAccountsEffect.Connected), effects)
        assertEquals(2, accounts.list.count)
        vm.close()
    }

    @Test fun `another account needs both mail servers and carries them and a given caldav server trimmed`() =
        runTest(dispatcher) {
            val boxes = ScriptedMailboxRepository()
            val vm = viewModel(boxes)
            runCurrent()
            vm.onAction(
                InternetAccountsAction.Connect(
                    InternetPasswordProvider.OTHER, "me@firma.cz", "pw", "imap.firma.cz", " ", "https://dav.firma.cz",
                ),
            )
            assertEquals(InternetConnectFailure.INVALID_INPUT, vm.state.value.connectFailure)
            vm.onAction(
                InternetAccountsAction.Connect(
                    InternetPasswordProvider.OTHER, "me@firma.cz", "pw", " imap.firma.cz ", "smtp.firma.cz", " ",
                ),
            )
            runCurrent()
            vm.onAction(
                InternetAccountsAction.Connect(
                    InternetPasswordProvider.OTHER,
                    "me@firma.cz",
                    "pw",
                    "imap.firma.cz",
                    "smtp.firma.cz",
                    " https://dav.firma.cz ",
                ),
            )
            runCurrent()
            assertEquals(
                listOf(
                    MailPasswordAccount(
                        MailPasswordProvider.GENERIC, "me@firma.cz", "pw", "imap.firma.cz", "smtp.firma.cz",
                    ),
                    MailPasswordAccount(
                        MailPasswordProvider.GENERIC,
                        "me@firma.cz",
                        "pw",
                        "imap.firma.cz",
                        "smtp.firma.cz",
                        caldavUrl = "https://dav.firma.cz",
                    ),
                ),
                boxes.connect.asked,
            )
            assertNull(vm.state.value.connectFailure)
            vm.close()
        }

    @Test fun `an icloud account ignores servers typed for another provider`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(
            InternetAccountsAction.Connect(
                InternetPasswordProvider.ICLOUD, "me@icloud.com", "pass", "imap.x", "smtp.x", "https://dav.x",
            ),
        )
        runCurrent()
        assertEquals(
            MailPasswordAccount(MailPasswordProvider.ICLOUD, "me@icloud.com", "pass", null, null),
            boxes.connect.asked.single(),
        )
        vm.close()
    }

    @Test fun `input that is no address or has no password is invalid and nothing is sent`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(icloud(address = "nobody"))
        assertEquals(InternetConnectFailure.INVALID_INPUT, vm.state.value.connectFailure)
        vm.onAction(InternetAccountsAction.DismissConnectFailure)
        assertNull(vm.state.value.connectFailure)
        vm.onAction(icloud(password = ""))
        assertEquals(InternetConnectFailure.INVALID_INPUT, vm.state.value.connectFailure)
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
                InternetConnectFailure.REFUSED,
                InternetConnectFailure.UNAVAILABLE,
                InternetConnectFailure.UNEXPECTED,
                InternetConnectFailure.UNEXPECTED,
            ),
            models.map { it.state.value.connectFailure },
        )
        assertTrue(models.none { it.state.value.connecting })
        assertTrue(effects.all { it.isEmpty() })
        models.forEach { it.close() }
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val accounts = ScriptedInternetAccountRepository(list = MailCall(neverAnswers()))
        val vm = viewModel(boxes, accounts)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(icloud())
        vm.onAction(InternetAccountsAction.Retry)
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, accounts.list.cancellations)
        assertEquals(1, accounts.list.count)
        assertEquals(0, boxes.connect.count)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val boxes = ScriptedInternetAccountRepository(list = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(boxes) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.list.cancellations)
    }
}
