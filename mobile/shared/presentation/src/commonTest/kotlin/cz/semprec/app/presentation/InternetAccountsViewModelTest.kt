package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailConnectOutcome
import cz.semprec.app.domain.MailConnectRefusal
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.OAuthOutcome
import cz.semprec.app.domain.OAuthProvider
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
    ) = InternetAccountViewModelFactory(accounts, mailboxes, indexHistory(), sync).accountsViewModel()

    private fun viewModel(accounts: ScriptedInternetAccountRepository) =
        viewModel(ScriptedMailboxRepository(), accounts)

    private fun icloud(address: String = "me@icloud.com", password: String = "pass") =
        InternetAccountsAction.Connect(InternetPasswordProvider.ICLOUD, address, password, "", "", "")

    private fun item(
        id: String,
        mail: InternetServiceStatus,
        calendars: InternetServiceStatus,
        canSignInAgain: Boolean = false,
    ) = InternetAccountItem(id, "Gmail", "me@gmail.com", "gmail", mail, calendars, canSignInAgain)

    private fun listing(vararg accounts: InternetAccount) =
        ScriptedInternetAccountRepository(
            list = MailCall(mailContent(accounts.toList()), mailContent(accounts.toList())),
        )

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
                item("b", InternetServiceStatus.NEEDS_REAUTHORIZATION, InternetServiceStatus.PENDING, true),
                item("c", InternetServiceStatus.OFF, InternetServiceStatus.OK),
                item("d", InternetServiceStatus.SYNCING, InternetServiceStatus.NEEDS_CONSENT),
                item("e", InternetServiceStatus.ERROR, InternetServiceStatus.SYNCING),
                item("f", InternetServiceStatus.OK, InternetServiceStatus.ERROR),
                item("g", InternetServiceStatus.OK, InternetServiceStatus.NEEDS_REAUTHORIZATION, true),
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

    @Test fun `every refusal the server names shows its own failure and keeps the form`() = runTest(dispatcher) {
        val cases = mapOf(
            MailConnectRefusal.WRONG_CREDENTIALS to InternetConnectFailure.WRONG_CREDENTIALS,
            MailConnectRefusal.APP_PASSWORD_REQUIRED to InternetConnectFailure.APP_PASSWORD_REQUIRED,
            MailConnectRefusal.SERVER_UNREACHABLE to InternetConnectFailure.SERVER_UNREACHABLE,
            MailConnectRefusal.TLS_FAILED to InternetConnectFailure.TLS_FAILED,
            MailConnectRefusal.CALDAV_REFUSED to InternetConnectFailure.CALDAV_REFUSED,
            MailConnectRefusal.CALDAV_UNREACHABLE to InternetConnectFailure.CALDAV_UNREACHABLE,
            MailConnectRefusal.ALREADY_CONNECTED to InternetConnectFailure.ALREADY_CONNECTED,
            MailConnectRefusal.RATE_LIMITED to InternetConnectFailure.RATE_LIMITED,
        )
        assertEquals(MailConnectRefusal.entries.toSet(), cases.keys)
        for ((refusal, failure) in cases) {
            val outcome: MailConnectOutcome = MailConnectOutcome.Refused(refusal)
            val accounts = ScriptedInternetAccountRepository()
            val vm = viewModel(ScriptedMailboxRepository(connect = MailCall(mailContent(outcome))), accounts)
            val effects = collectEffects(vm)
            runCurrent()
            vm.onAction(icloud())
            runCurrent()
            assertEquals(failure, vm.state.value.connectFailure)
            assertFalse(vm.state.value.connecting)
            // The listed account holds another address.
            assertNull(vm.state.value.existingAccountId)
            assertTrue(effects.isEmpty())
            assertEquals(1, accounts.list.count)
            vm.close()
        }
    }

    @Test fun `a connect refused as already connected names the listed account and opens it`() = runTest(dispatcher) {
        val listed = internetAccount("a").let {
            it.copy(mailbox = it.mailbox.copy(primaryAddress = "Me@iCloud.com", provider = "icloud"))
        }
        val already: MailConnectOutcome = MailConnectOutcome.Refused(MailConnectRefusal.ALREADY_CONNECTED)
        val boxes = ScriptedMailboxRepository(connect = MailCall(mailContent(already)))
        val vm = viewModel(boxes, ScriptedInternetAccountRepository(list = MailCall(mailContent(listOf(listed)))))
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(icloud("me@icloud.com"))
        runCurrent()
        assertEquals(InternetConnectFailure.ALREADY_CONNECTED, vm.state.value.connectFailure)
        assertEquals("a", vm.state.value.existingAccountId)

        vm.onAction(InternetAccountsAction.OpenExisting)
        runCurrent()
        assertEquals(listOf<InternetAccountsEffect>(InternetAccountsEffect.OpenAccount("a")), effects)
        assertNull(vm.state.value.connectFailure)
        assertNull(vm.state.value.existingAccountId)
        vm.onAction(InternetAccountsAction.OpenExisting)
        runCurrent()
        assertEquals(1, effects.size)
        vm.close()
    }

    @Test fun `the accounts whose sign-in a service no longer accepts can sign in again`() = runTest(dispatcher) {
        val cases = listOf(
            internetAccount("gmail", MailSyncStatus.NEEDS_REAUTHORIZATION, provider = "gmail") to true,
            internetAccount("outlook", MailSyncStatus.NEEDS_REAUTHORIZATION, provider = "outlook") to true,
            internetAccount("icloud", MailSyncStatus.NEEDS_REAUTHORIZATION, provider = "icloud") to true,
            internetAccount(
                "generic",
                calendars = true,
                calendarStatus = CalendarSyncStatus.NEEDS_REAUTHORIZATION,
                provider = "generic",
            ) to true,
            internetAccount("unknown", MailSyncStatus.NEEDS_REAUTHORIZATION, provider = "exchange") to false,
            internetAccount("error", MailSyncStatus.ERROR, provider = "icloud") to false,
            // Mail switched off shows off, whatever the server still holds.
            internetAccount("off", MailSyncStatus.NEEDS_REAUTHORIZATION, mail = false, provider = "icloud") to false,
        )
        val vm = viewModel(listing(*cases.map { it.first }.toTypedArray()))
        runCurrent()
        assertEquals(cases.map { it.second }, vm.state.value.accounts.map { it.canSignInAgain })
        vm.close()
    }

    @Test fun `a listed browser account signs in again in a browser and the list loads again`() = runTest(dispatcher) {
        val accounts = listing(
            internetAccount("a", MailSyncStatus.NEEDS_REAUTHORIZATION, provider = "outlook"),
            internetAccount("b"),
        )
        val vm = viewModel(accounts)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(InternetAccountsAction.SignInAgain("b"))
        runCurrent()
        assertEquals(0, accounts.reauthorizations.count)

        vm.onAction(InternetAccountsAction.SignInAgain("a"))
        assertTrue(vm.state.value.signingIn)
        assertFalse(vm.state.value.connecting)
        vm.onAction(InternetAccountsAction.SignInAgain("a"))
        vm.onAction(InternetAccountsAction.SignIn.Start(InternetOAuthProvider.GOOGLE, calendars = false))
        runCurrent()
        assertEquals(listOf("a" to emptySet<InternetService>()), accounts.reauthorizations.asked)
        assertEquals(0, accounts.signIns.count)

        vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
        runCurrent()
        assertEquals(listOf(OAUTH_SIGN_IN to OAUTH_CALLBACK), accounts.finishes.asked)
        assertFalse(vm.state.value.signingIn)
        assertNull(vm.state.value.signInFailure)
        assertEquals(2, accounts.list.count)
        // Signing in again connects no new account, so the add form has nothing to close.
        assertEquals(
            listOf<InternetAccountsEffect>(InternetAccountsEffect.OpenSignIn(OAUTH_SIGN_IN.authorizeUrl)),
            effects,
        )
        vm.close()
    }

    @Test fun `a listed browser account that fails to sign in again says why`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository(
            list = MailCall(mailContent(listOf(internetAccount("a", MailSyncStatus.NEEDS_REAUTHORIZATION)))),
            finishes = MailCall(mailContent(OAuthOutcome.Declined)),
        )
        val vm = viewModel(accounts)
        runCurrent()
        vm.onAction(InternetAccountsAction.SignInAgain("a"))
        runCurrent()
        vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
        runCurrent()
        assertEquals(InternetConnectFailure.DECLINED, vm.state.value.signInFailure)
        assertNull(vm.state.value.connectFailure)
        assertFalse(vm.state.value.signingIn)
        assertEquals(1, accounts.list.count)
        vm.onAction(InternetAccountsAction.DismissSignInFailure)
        assertNull(vm.state.value.signInFailure)
        vm.close()
    }

    @Test fun `a listed password account signs in again with its password and the list loads again`() =
        runTest(dispatcher) {
            val listed = internetAccount("a", MailSyncStatus.NEEDS_REAUTHORIZATION, provider = "icloud")
            val accounts = listing(listed)
            val refused: MailConnectOutcome = MailConnectOutcome.Refused(MailConnectRefusal.APP_PASSWORD_REQUIRED)
            val boxes = ScriptedMailboxRepository(
                passwords = MailCall(mailContent(refused), mailContent(MailConnectOutcome.Connected("m1"))),
            )
            val vm = viewModel(boxes, accounts)
            val effects = collectEffects(vm)
            runCurrent()

            vm.onAction(InternetAccountsAction.SignInAgain("a"))
            assertEquals(InternetPasswordSignIn("a", "me@gmail.com", icloud = true), vm.state.value.passwordSignIn)
            vm.onAction(InternetAccountsAction.PasswordSignIn(InternetPasswordSignInStep.Submit("account-pass", "")))
            runCurrent()
            assertEquals(InternetConnectFailure.APP_PASSWORD_REQUIRED, vm.state.value.passwordSignIn?.failure)
            assertEquals(1, accounts.list.count)

            vm.onAction(InternetAccountsAction.PasswordSignIn(InternetPasswordSignInStep.Submit("app-pass", "")))
            assertEquals(
                InternetPasswordSignIn("a", "me@gmail.com", icloud = true, submitting = true),
                vm.state.value.passwordSignIn,
            )
            runCurrent()
            assertEquals(
                listOf<Triple<String, String, String?>>(
                    Triple("a", "account-pass", null),
                    Triple("a", "app-pass", null),
                ),
                boxes.passwords.asked,
            )
            assertNull(vm.state.value.passwordSignIn)
            assertEquals(2, accounts.list.count)
            assertEquals(0, accounts.reauthorizations.count)
            assertTrue(effects.isEmpty())
            vm.close()
        }

    @Test fun `a browser sign-in asks for the chosen services opens the page and connects with what came back`() =
        runTest(dispatcher) {
            val cases = listOf(
                InternetAccountsAction.SignIn.Start(InternetOAuthProvider.GOOGLE, calendars = true) to
                    (OAuthProvider.GOOGLE to setOf(InternetService.MAIL, InternetService.CALENDARS)),
                InternetAccountsAction.SignIn.Start(InternetOAuthProvider.MICROSOFT, calendars = false) to
                    (OAuthProvider.MICROSOFT to setOf(InternetService.MAIL)),
            )
            for ((start, asked) in cases) {
                val accounts = ScriptedInternetAccountRepository()
                val vm = viewModel(accounts)
                val effects = collectEffects(vm)
                runCurrent()

                vm.onAction(start)
                assertTrue(vm.state.value.connecting)
                vm.onAction(start)
                runCurrent()
                assertEquals(listOf(asked), accounts.signIns.asked)
                assertEquals(
                    listOf<InternetAccountsEffect>(InternetAccountsEffect.OpenSignIn(OAUTH_SIGN_IN.authorizeUrl)),
                    effects,
                )
                assertTrue(vm.state.value.connecting)
                assertEquals(1, accounts.list.count)

                vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
                vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
                runCurrent()
                assertEquals(listOf(OAUTH_SIGN_IN to OAUTH_CALLBACK), accounts.finishes.asked)
                assertFalse(vm.state.value.connecting)
                assertNull(vm.state.value.connectFailure)
                assertEquals(InternetAccountsEffect.Connected, effects.last())
                assertEquals(2, accounts.list.count)
                vm.close()
            }
        }

    @Test fun `a cancelled sign-in sends nothing to the server and leaves no failure`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository()
        val vm = viewModel(accounts)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(InternetAccountsAction.SignIn.Start(InternetOAuthProvider.GOOGLE, calendars = true))
        runCurrent()

        vm.onAction(InternetAccountsAction.SignIn.Cancelled)
        runCurrent()
        assertFalse(vm.state.value.connecting)
        assertNull(vm.state.value.connectFailure)
        // A late answer of the browser belongs to no sign-in any more.
        vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
        runCurrent()
        assertEquals(0, accounts.finishes.count)
        assertEquals(1, accounts.list.count)
        assertEquals(
            listOf<InternetAccountsEffect>(InternetAccountsEffect.OpenSignIn(OAUTH_SIGN_IN.authorizeUrl)),
            effects,
        )
        vm.close()
    }

    @Test fun `a sign-in that fails says why and connects nothing`() = runTest(dispatcher) {
        val start = InternetAccountsAction.SignIn.Start(InternetOAuthProvider.GOOGLE, calendars = false)
        val returned = InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK)
        // The repository, how the browser ended (nothing when the sign-in did not start) and the failure shown.
        val cases = listOf<Triple<ScriptedInternetAccountRepository, InternetAccountsAction?, InternetConnectFailure>>(
            Triple(
                ScriptedInternetAccountRepository(signIns = MailCall(mailFailure(FailureKind.UNAVAILABLE))),
                null,
                InternetConnectFailure.UNAVAILABLE,
            ),
            Triple(
                ScriptedInternetAccountRepository(signIns = MailCall({ error("unexpected") })),
                null,
                InternetConnectFailure.UNEXPECTED,
            ),
            Triple(
                ScriptedInternetAccountRepository(finishes = MailCall(mailContent(OAuthOutcome.Declined))),
                returned,
                InternetConnectFailure.DECLINED,
            ),
            Triple(
                ScriptedInternetAccountRepository(finishes = MailCall(mailFailure(FailureKind.REJECTED))),
                returned,
                InternetConnectFailure.REFUSED,
            ),
            Triple(
                ScriptedInternetAccountRepository(finishes = MailCall(mailFailure(FailureKind.INVALID_DATA))),
                returned,
                InternetConnectFailure.UNEXPECTED,
            ),
            Triple(
                ScriptedInternetAccountRepository(),
                InternetAccountsAction.SignIn.Failed,
                InternetConnectFailure.UNEXPECTED,
            ),
        )
        for ((accounts, end, failure) in cases) {
            val vm = viewModel(accounts)
            val effects = collectEffects(vm)
            runCurrent()
            vm.onAction(start)
            runCurrent()
            end?.let(vm::onAction)
            runCurrent()
            assertFalse(vm.state.value.connecting)
            assertEquals(failure, vm.state.value.connectFailure)
            assertFalse(InternetAccountsEffect.Connected in effects)
            assertEquals(1, accounts.list.count)
            vm.onAction(InternetAccountsAction.DismissConnectFailure)
            assertNull(vm.state.value.connectFailure)
            vm.close()
        }
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
