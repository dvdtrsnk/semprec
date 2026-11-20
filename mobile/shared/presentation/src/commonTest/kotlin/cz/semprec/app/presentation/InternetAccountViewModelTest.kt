package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.OAuthOutcome
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.CompletableDeferred
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
class InternetAccountViewModelTest : MainDispatcherTest() {
    private val sync = SyncChanges()

    private fun viewModel(
        mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository(),
        accounts: ScriptedInternetAccountRepository = ScriptedInternetAccountRepository(),
    ) = InternetAccountViewModelFactory(accounts, mailboxes, sync).accountViewModel("m1")

    private fun viewModel(accounts: ScriptedInternetAccountRepository) =
        viewModel(ScriptedMailboxRepository(), accounts)

    private fun mailChanged() = sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))

    @Test fun `shows the account with what its sync did`() = runTest(dispatcher) {
        val boxes = ScriptedInternetAccountRepository(
            one = MailCall(
                mailContent(
                    internetAccount(
                        status = MailSyncStatus.NEEDS_REAUTHORIZATION,
                        calendars = true,
                        calendarStatus = CalendarSyncStatus.NEEDS_CONSENT,
                    ),
                ),
            ),
        )
        val vm = viewModel(boxes)
        assertEquals(InternetAccountPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val account = vm.state.value.account
        assertEquals(InternetAccountPhase.CONTENT, vm.state.value.phase)
        assertEquals("Gmail", account?.name)
        assertEquals(InternetServiceStatus.NEEDS_REAUTHORIZATION, account?.mail)
        assertEquals(InternetServiceStatus.NEEDS_CONSENT, account?.calendars)
        assertEquals(true, account?.mailEnabled)
        assertEquals(true, account?.calendarsEnabled)
        assertEquals("2026-10-19T09:12:00.000Z", account?.failingSince)
        assertEquals(3, account?.connectionLimit)
        assertEquals(1, account?.autonomousSendProjectCount)
        assertEquals(listOf("m1"), boxes.one.asked)
        vm.close()
    }

    @Test fun `an account change the server reports reads the status again and keeps a name changed meanwhile`() =
        runTest(dispatcher) {
            fun account(mailbox: MailAccount) = internetAccount().copy(mailbox = mailbox)
            val boxes = ScriptedInternetAccountRepository(
                one = MailCall(
                    mailContent(
                        account(mailAccount(initial = true).copy(syncedMessageCount = 10, lastSuccessfulSyncAt = null)),
                    ),
                    mailFailure(FailureKind.UNAVAILABLE),
                    mailContent(
                        account(mailAccount(initial = true).copy(name = "Server name", syncedMessageCount = 20)),
                    ),
                    mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.OK)),
                ),
            )
            val vm = viewModel(ScriptedMailboxRepository(), boxes)
            runCurrent()
            assertEquals(InternetServiceStatus.SYNCING, vm.state.value.account?.mail)
            assertEquals(10, vm.state.value.account?.syncedMessageCount)
            vm.onAction(InternetAccountAction.Rename("Work"))
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
            assertEquals(InternetAccountPhase.CONTENT, vm.state.value.phase)
            mailChanged()
            runCurrent()
            assertEquals(20, vm.state.value.account?.syncedMessageCount)
            assertEquals("2026-10-19T08:12:00.000Z", vm.state.value.account?.lastSuccessfulSyncAt)
            assertEquals("Work", vm.state.value.account?.name)
            mailChanged()
            runCurrent()
            assertEquals(InternetServiceStatus.OK, vm.state.value.account?.mail)
            assertEquals(true, vm.state.value.account?.calendarsEnabled)
            assertEquals(InternetServiceStatus.OK, vm.state.value.account?.calendars)
            assertEquals("Work", vm.state.value.account?.name)
            assertEquals(4, boxes.one.count)
            vm.close()
        }

    @Test fun `an error shows its kind and retry loads again`() = runTest(dispatcher) {
        val boxes = ScriptedInternetAccountRepository(
            one = MailCall(mailFailure(FailureKind.NOT_FOUND), mailContent(internetAccount())),
        )
        val vm = viewModel(boxes)
        val crashed = viewModel(ScriptedInternetAccountRepository(one = MailCall(crashes())))
        runCurrent()
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)
        assertNull(crashed.state.value.failure)
        assertEquals(InternetAccountPhase.ERROR, crashed.state.value.phase)
        vm.onAction(InternetAccountAction.Retry)
        runCurrent()
        assertEquals(InternetAccountPhase.CONTENT, vm.state.value.phase)
        vm.close()
        crashed.close()
    }

    @Test fun `a new name is shown at once and written and a blank or unchanged one is ignored`() =
        runTest(dispatcher) {
            val boxes = ScriptedMailboxRepository()
            val vm = viewModel(boxes)
            runCurrent()
            vm.onAction(InternetAccountAction.Rename("  "))
            vm.onAction(InternetAccountAction.Rename("Gmail"))
            vm.onAction(InternetAccountAction.Rename(" Osobní "))
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
        vm.onAction(InternetAccountAction.Rename("Osobní"))
        runCurrent()
        assertEquals("Gmail", vm.state.value.account?.name)
        assertTrue(vm.state.value.actionFailed)
        vm.onAction(InternetAccountAction.DismissFailure)
        assertFalse(vm.state.value.actionFailed)
        vm.close()
    }

    @Test fun `the connection limit steps within one and fifteen and is written`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        runCurrent()
        vm.onAction(InternetAccountAction.StepConnectionLimit(1))
        assertEquals(4, vm.state.value.account?.connectionLimit)
        vm.onAction(InternetAccountAction.StepConnectionLimit(100))
        assertEquals(15, vm.state.value.account?.connectionLimit)
        vm.onAction(InternetAccountAction.StepConnectionLimit(1))
        vm.onAction(InternetAccountAction.StepConnectionLimit(-100))
        assertEquals(1, vm.state.value.account?.connectionLimit)
        vm.onAction(InternetAccountAction.StepConnectionLimit(-1))
        runCurrent()
        assertEquals(listOf("m1" to 4, "m1" to 15, "m1" to 1), boxes.limit.asked)
        vm.close()
    }

    @Test fun `a refused limit is put back and a mailbox without the setting ignores the step`() = runTest(dispatcher) {
        val refused = ScriptedMailboxRepository(limit = MailCall(mailFailure(FailureKind.REJECTED)))
        val gmailApi = ScriptedMailboxRepository()
        val first = viewModel(refused)
        val second = viewModel(
            gmailApi,
            ScriptedInternetAccountRepository(one = MailCall(mailContent(internetAccount(limitApplies = false)))),
        )
        runCurrent()
        first.onAction(InternetAccountAction.StepConnectionLimit(1))
        second.onAction(InternetAccountAction.StepConnectionLimit(1))
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
        vm.onAction(InternetAccountAction.Removal.Request)
        assertEquals(InternetAccountRemovalPhase.LOADING_IMPACT, vm.state.value.removal)
        runCurrent()
        assertEquals(InternetAccountRemovalPhase.CONFIRMING, vm.state.value.removal)
        assertEquals(InternetAccountRemovalImpact(120, 2, 50, 7), vm.state.value.impact)
        assertEquals(0, boxes.remove.count)
        vm.onAction(InternetAccountAction.Removal.Cancel)
        assertEquals(InternetAccountRemovalPhase.IDLE, vm.state.value.removal)
        assertNull(vm.state.value.impact)
        assertEquals(emptyList(), effects)
        vm.close()
    }

    @Test fun `a confirmed removal removes the account and closes the screen`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val vm = viewModel(boxes)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(InternetAccountAction.Removal.Confirm)
        assertEquals(0, boxes.remove.count)
        vm.onAction(InternetAccountAction.Removal.Request)
        runCurrent()
        vm.onAction(InternetAccountAction.Removal.Confirm)
        assertEquals(InternetAccountRemovalPhase.REMOVING, vm.state.value.removal)
        runCurrent()
        assertEquals(listOf("m1"), boxes.remove.asked)
        assertEquals(listOf<InternetAccountEffect>(InternetAccountEffect.Removed), effects)
        vm.close()
    }

    @Test fun `a refused removal returns to the question and an impact that fails stays idle`() = runTest(dispatcher) {
        val refused = ScriptedMailboxRepository(remove = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val noImpact = ScriptedMailboxRepository(impact = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val first = viewModel(refused)
        val second = viewModel(noImpact)
        runCurrent()
        first.onAction(InternetAccountAction.Removal.Request)
        second.onAction(InternetAccountAction.Removal.Request)
        runCurrent()
        first.onAction(InternetAccountAction.Removal.Confirm)
        runCurrent()
        assertEquals(InternetAccountRemovalPhase.CONFIRMING, first.state.value.removal)
        assertTrue(first.state.value.actionFailed)
        assertEquals(InternetAccountRemovalPhase.IDLE, second.state.value.removal)
        assertTrue(second.state.value.actionFailed)
        first.close()
        second.close()
    }

    @Test fun `switching calendars on writes it and shows it pending then asks for notifications and reads the status`() =
        runTest(dispatcher) {
            val accounts = ScriptedInternetAccountRepository(
                one = MailCall(
                    mailContent(internetAccount()),
                    mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.NEVER)),
                ),
            )
            val vm = viewModel(accounts)
            val effects = collectEffects(vm)
            runCurrent()
            assertEquals(InternetServiceStatus.OFF, vm.state.value.account?.calendars)

            vm.onAction(InternetAccountAction.SetService(InternetAccountService.CALENDARS, true))
            assertEquals(true, vm.state.value.account?.calendarsEnabled)
            assertEquals(InternetServiceStatus.PENDING, vm.state.value.account?.calendars)
            assertNull(vm.state.value.confirmingOff)
            runCurrent()

            assertEquals(listOf(Triple("m1", InternetService.CALENDARS, true)), accounts.services.asked)
            assertEquals(listOf<InternetAccountEffect>(InternetAccountEffect.CalendarsTurnedOn), effects)
            assertEquals(2, accounts.one.count)
            assertEquals(InternetServiceStatus.SYNCING, vm.state.value.account?.calendars)
            assertFalse(vm.state.value.actionFailed)
            vm.close()
        }

    @Test fun `switching mail on writes it without asking and raises no notification request`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository(one = MailCall(mailContent(internetAccount(mail = false))))
        val vm = viewModel(accounts)
        val effects = collectEffects(vm)
        runCurrent()
        assertEquals(InternetServiceStatus.OFF, vm.state.value.account?.mail)
        vm.onAction(InternetAccountAction.SetService(InternetAccountService.MAIL, true))
        assertEquals(InternetServiceStatus.SYNCING, vm.state.value.account?.mail)
        vm.onAction(InternetAccountAction.SetService(InternetAccountService.MAIL, true))
        runCurrent()
        assertEquals(listOf(Triple("m1", InternetService.MAIL, true)), accounts.services.asked)
        assertEquals(emptyList(), effects)
        vm.close()
    }

    @Test fun `switching a service off asks first and writes only when confirmed`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository(
            one = MailCall(mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.OK))),
        )
        val vm = viewModel(accounts)
        runCurrent()
        vm.onAction(InternetAccountAction.SetService(InternetAccountService.MAIL, false))
        assertEquals(InternetAccountService.MAIL, vm.state.value.confirmingOff)
        assertEquals(true, vm.state.value.account?.mailEnabled)
        vm.onAction(InternetAccountAction.CancelServiceOff)
        runCurrent()
        assertNull(vm.state.value.confirmingOff)
        assertEquals(0, accounts.services.count)

        vm.onAction(InternetAccountAction.SetService(InternetAccountService.CALENDARS, false))
        vm.onAction(InternetAccountAction.ConfirmServiceOff)
        assertEquals(false, vm.state.value.account?.calendarsEnabled)
        assertEquals(InternetServiceStatus.OFF, vm.state.value.account?.calendars)
        vm.onAction(InternetAccountAction.ConfirmServiceOff)
        runCurrent()
        assertEquals(listOf(Triple("m1", InternetService.CALENDARS, false)), accounts.services.asked)
        vm.close()
    }

    @Test fun `a switch the server refuses such as mail off while the mailbox syncs is put back and says so`() =
        runTest(dispatcher) {
            val accounts = ScriptedInternetAccountRepository(
                services = MailCall(mailFailure(FailureKind.REJECTED), crashes()),
            )
            val vm = viewModel(accounts)
            val effects = collectEffects(vm)
            runCurrent()
            vm.onAction(InternetAccountAction.SetService(InternetAccountService.MAIL, false))
            vm.onAction(InternetAccountAction.ConfirmServiceOff)
            runCurrent()
            assertEquals(true, vm.state.value.account?.mailEnabled)
            assertEquals(InternetServiceStatus.OK, vm.state.value.account?.mail)
            assertTrue(vm.state.value.actionFailed)
            vm.onAction(InternetAccountAction.DismissFailure)

            vm.onAction(InternetAccountAction.SetService(InternetAccountService.CALENDARS, true))
            runCurrent()
            assertEquals(false, vm.state.value.account?.calendarsEnabled)
            assertEquals(InternetServiceStatus.OFF, vm.state.value.account?.calendars)
            assertTrue(vm.state.value.actionFailed)
            assertEquals(emptyList(), effects)
            assertEquals(1, accounts.one.count)
            vm.close()
        }

    @Test fun `a status read while a switch is written keeps the switch as shown`() = runTest(dispatcher) {
        val write = CompletableDeferred<RepositoryResult<Unit>>()
        val accounts = ScriptedInternetAccountRepository(
            one = MailCall(
                mailContent(internetAccount()),
                mailContent(internetAccount().copy(mailbox = mailAccount().copy(syncedMessageCount = 5))),
                mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.OK)),
            ),
            services = MailCall({ write.await() }),
        )
        val vm = viewModel(accounts)
        runCurrent()
        vm.onAction(InternetAccountAction.SetService(InternetAccountService.CALENDARS, true))
        runCurrent()
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(5, vm.state.value.account?.syncedMessageCount)
        assertEquals(true, vm.state.value.account?.calendarsEnabled)
        assertEquals(InternetServiceStatus.PENDING, vm.state.value.account?.calendars)
        write.complete(RepositoryResult.Content(Unit))
        runCurrent()
        assertEquals(InternetServiceStatus.OK, vm.state.value.account?.calendars)
        vm.close()
    }

    @Test fun `sync now asks the server once at a time and only while calendars is on`() = runTest(dispatcher) {
        val off = ScriptedInternetAccountRepository()
        val on = ScriptedInternetAccountRepository(
            one = MailCall(mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.OK))),
            syncs = MailCall(mailContent(Unit), mailFailure(FailureKind.UNAVAILABLE)),
        )
        val withoutCalendars = viewModel(off)
        val vm = viewModel(on)
        runCurrent()
        withoutCalendars.onAction(InternetAccountAction.SyncNow)
        vm.onAction(InternetAccountAction.SyncNow)
        assertTrue(vm.state.value.syncRequested)
        vm.onAction(InternetAccountAction.SyncNow)
        runCurrent()
        assertFalse(vm.state.value.syncRequested)
        assertFalse(vm.state.value.actionFailed)
        vm.onAction(InternetAccountAction.SyncNow)
        runCurrent()
        assertTrue(vm.state.value.actionFailed)
        assertEquals(listOf("m1", "m1"), on.syncs.asked)
        assertEquals(0, off.syncs.count)
        withoutCalendars.close()
        vm.close()
    }

    @Test fun `an account that must sign in again does so in the browser and is read again`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository(
            one = MailCall(
                mailContent(internetAccount(status = MailSyncStatus.NEEDS_REAUTHORIZATION)),
                mailContent(internetAccount()),
            ),
        )
        val vm = viewModel(accounts)
        val effects = collectEffects(vm)
        runCurrent()
        assertEquals(true, vm.state.value.account?.canSignInAgain)
        assertEquals(false, vm.state.value.account?.canAllowCalendarAccess)

        vm.onAction(InternetAccountAction.SignIn.Again)
        assertTrue(vm.state.value.signingIn)
        vm.onAction(InternetAccountAction.SignIn.Again)
        runCurrent()
        assertEquals(listOf("m1" to emptySet<InternetService>()), accounts.reauthorizations.asked)
        assertEquals(
            listOf<InternetAccountEffect>(InternetAccountEffect.OpenSignIn(OAUTH_SIGN_IN.authorizeUrl)),
            effects,
        )

        vm.onAction(InternetAccountAction.SignIn.Returned(OAUTH_CALLBACK))
        runCurrent()
        assertEquals(listOf(OAUTH_SIGN_IN to OAUTH_CALLBACK), accounts.finishes.asked)
        assertFalse(vm.state.value.signingIn)
        assertNull(vm.state.value.signInFailure)
        assertEquals(InternetServiceStatus.OK, vm.state.value.account?.mail)
        assertEquals(false, vm.state.value.account?.canSignInAgain)
        vm.close()
    }

    @Test fun `allowing calendar access asks for calendars and turns the calendar status to the server's`() =
        runTest(dispatcher) {
            val accounts = ScriptedInternetAccountRepository(
                one = MailCall(
                    mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.NEEDS_CONSENT)),
                    mailContent(internetAccount(calendars = true, calendarStatus = CalendarSyncStatus.NEVER)),
                ),
            )
            val vm = viewModel(accounts)
            runCurrent()
            assertEquals(true, vm.state.value.account?.canAllowCalendarAccess)
            assertEquals(false, vm.state.value.account?.canSignInAgain)

            vm.onAction(InternetAccountAction.SignIn.AllowCalendarAccess)
            runCurrent()
            vm.onAction(InternetAccountAction.SignIn.Returned(OAUTH_CALLBACK))
            runCurrent()
            assertEquals(
                listOf("m1" to setOf(InternetService.MAIL, InternetService.CALENDARS)),
                accounts.reauthorizations.asked,
            )
            assertEquals(InternetServiceStatus.SYNCING, vm.state.value.account?.calendars)
            assertEquals(false, vm.state.value.account?.canAllowCalendarAccess)
            vm.close()
        }

    @Test fun `signing in again is offered only to a browser account that needs it`() = runTest(dispatcher) {
        val cases = listOf(
            // Nothing to fix.
            internetAccount(calendars = true),
            // A password account signs in again with its password, not in a browser.
            internetAccount(
                status = MailSyncStatus.NEEDS_REAUTHORIZATION,
                calendars = true,
                calendarStatus = CalendarSyncStatus.NEEDS_CONSENT,
                provider = "icloud",
            ),
        )
        for (account in cases) {
            val accounts = ScriptedInternetAccountRepository(one = MailCall(mailContent(account)))
            val vm = viewModel(accounts)
            runCurrent()
            assertEquals(false, vm.state.value.account?.canSignInAgain)
            assertEquals(false, vm.state.value.account?.canAllowCalendarAccess)
            vm.onAction(InternetAccountAction.SignIn.Again)
            vm.onAction(InternetAccountAction.SignIn.AllowCalendarAccess)
            runCurrent()
            assertFalse(vm.state.value.signingIn)
            assertEquals(0, accounts.reauthorizations.count)
            vm.close()
        }
    }

    @Test fun `a cancelled sign-in changes nothing and one that fails says why`() = runTest(dispatcher) {
        fun needsSignIn() = MailCall<String, InternetAccount>(
            mailContent(internetAccount(status = MailSyncStatus.NEEDS_REAUTHORIZATION)),
        )
        val cases = listOf<Triple<ScriptedInternetAccountRepository, InternetAccountAction, InternetConnectFailure?>>(
            Triple(
                ScriptedInternetAccountRepository(one = needsSignIn()),
                InternetAccountAction.SignIn.Cancelled,
                null,
            ),
            Triple(
                ScriptedInternetAccountRepository(one = needsSignIn()),
                InternetAccountAction.SignIn.Failed,
                InternetConnectFailure.UNEXPECTED,
            ),
            Triple(
                ScriptedInternetAccountRepository(
                    one = needsSignIn(),
                    finishes = MailCall(mailContent(OAuthOutcome.Declined)),
                ),
                InternetAccountAction.SignIn.Returned(OAUTH_CALLBACK),
                InternetConnectFailure.DECLINED,
            ),
            Triple(
                ScriptedInternetAccountRepository(
                    one = needsSignIn(),
                    // Another account than this one, or a code the provider no longer accepts.
                    finishes = MailCall(mailFailure(FailureKind.REJECTED)),
                ),
                InternetAccountAction.SignIn.Returned(OAUTH_CALLBACK),
                InternetConnectFailure.REFUSED,
            ),
        )
        for ((accounts, end, failure) in cases) {
            val vm = viewModel(accounts)
            runCurrent()
            val reads = accounts.one.count
            vm.onAction(InternetAccountAction.SignIn.Again)
            runCurrent()
            vm.onAction(end)
            runCurrent()
            assertFalse(vm.state.value.signingIn)
            assertEquals(failure, vm.state.value.signInFailure)
            assertEquals(reads, accounts.one.count)
            assertEquals(InternetServiceStatus.NEEDS_REAUTHORIZATION, vm.state.value.account?.mail)
            vm.onAction(InternetAccountAction.DismissFailure)
            assertNull(vm.state.value.signInFailure)
            vm.close()
        }
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository()
        val accounts = ScriptedInternetAccountRepository(one = MailCall(neverAnswers()))
        val vm = viewModel(boxes, accounts)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(InternetAccountAction.Retry)
        vm.onAction(InternetAccountAction.Removal.Request)
        vm.onAction(InternetAccountAction.SetService(InternetAccountService.CALENDARS, true))
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, accounts.one.cancellations)
        assertEquals(1, accounts.one.count)
        assertEquals(0, boxes.impact.count)
        assertEquals(0, accounts.services.count)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val boxes = ScriptedInternetAccountRepository(one = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(boxes) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, boxes.one.cancellations)
    }
}
