package cz.alldots.app.presentation

import cz.alldots.app.domain.MailConnectRefusal
import cz.alldots.app.domain.MailSyncStatus
import cz.alldots.app.domain.OAuthOutcome
import cz.alldots.app.domain.SyncChanges
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/** A browser sign-in whose account the server refuses names why, for a new account and for one signed in again. */
@OptIn(ExperimentalCoroutinesApi::class)
class BrowserSignInRefusalTest : MainDispatcherTest() {
    private fun viewModel(accounts: ScriptedInternetAccountRepository) =
        InternetAccountViewModelFactory(accounts, ScriptedMailboxRepository(), indexHistory(), SyncChanges())
            .accountsViewModel()

    @Test fun `a new account the server refuses shows the refusal and connects nothing`() = runTest(dispatcher) {
        val cases = mapOf(
            MailConnectRefusal.ALREADY_CONNECTED to InternetConnectFailure.ALREADY_CONNECTED,
            MailConnectRefusal.MAIL_CONSENT_MISSING to InternetConnectFailure.MAIL_CONSENT_MISSING,
        )
        for ((refusal, failure) in cases) {
            val accounts = ScriptedInternetAccountRepository(
                finishes = MailCall(mailContent(OAuthOutcome.Refused(refusal))),
            )
            val vm = viewModel(accounts)
            val effects = collectEffects(vm)
            runCurrent()
            vm.onAction(InternetAccountsAction.SignIn.Start(InternetOAuthProvider.GOOGLE, calendars = false))
            runCurrent()
            vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
            runCurrent()
            assertEquals(failure, vm.state.value.connectFailure)
            assertFalse(vm.state.value.connecting)
            assertFalse(InternetAccountsEffect.Connected in effects)
            assertEquals(1, accounts.list.count)
            vm.close()
        }
    }

    @Test fun `signing in again with another account says so and keeps the list`() = runTest(dispatcher) {
        val accounts = ScriptedInternetAccountRepository(
            list = MailCall(mailContent(listOf(internetAccount("a", MailSyncStatus.NEEDS_REAUTHORIZATION)))),
            finishes = MailCall(mailContent(OAuthOutcome.Refused(MailConnectRefusal.WRONG_ACCOUNT))),
        )
        val vm = viewModel(accounts)
        runCurrent()
        vm.onAction(InternetAccountsAction.SignInAgain("a"))
        runCurrent()
        vm.onAction(InternetAccountsAction.SignIn.Returned(OAUTH_CALLBACK))
        runCurrent()
        assertEquals(InternetConnectFailure.WRONG_ACCOUNT, vm.state.value.signInFailure)
        assertNull(vm.state.value.connectFailure)
        assertFalse(vm.state.value.signingIn)
        assertEquals(1, accounts.list.count)
        vm.close()
    }
}
