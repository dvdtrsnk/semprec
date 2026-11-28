package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AccountDevice
import cz.alldots.app.domain.AccountRepository
import cz.alldots.app.domain.AccountSummary
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SessionStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val SUMMARY = AccountSummary(4, 2, 1, 7, 2, 3, 24.12)
private val FIGURES = ProfileFigures(4, 2, 1, 9, 3, 24.12)

/** The account calls of the profile; each call takes its next scripted step. */
private class ScriptedProfileAccount(
    summary: List<ScriptedStep<AccountSummary>> = listOf({ RepositoryResult.Content(SUMMARY) }),
    locale: List<ScriptedStep<Unit>> = listOf({ RepositoryResult.Content(Unit) }),
) : AccountRepository {
    val summaries = CallScript(summary)
    val locales = CallScript(locale)
    val asked = mutableListOf<String>()

    override suspend fun summary() = summaries.next()

    override suspend fun devices(): RepositoryResult<List<AccountDevice>> = error("not used")

    override suspend fun revokeDevice(deviceId: String): RepositoryResult<Unit> = error("not used")

    override suspend fun revokeOtherDevices(): RepositoryResult<Unit> = error("not used")

    override suspend fun changeLocale(locale: String): RepositoryResult<Unit> {
        asked += locale
        return locales.next()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ProfileViewModelTest : MainDispatcherTest() {
    private val signedIn = SessionStatus.SignedIn(testSession)

    private fun viewModel(
        account: ScriptedProfileAccount,
        auth: FakeAuthRepository = FakeAuthRepository(initial = signedIn),
    ) = accountFactory(account, auth).profileViewModel()

    @Test fun `starts with who is signed in and publishes the figures of the summary`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedProfileAccount())
        assertEquals(
            ProfileState(
                email = "a@b.cz",
                serverUrl = "https://s.example",
                locale = "cs",
                locales = listOf("cs", "en"),
            ),
            vm.state.value,
        )
        runCurrent()
        assertEquals(ProfilePhase.CONTENT, vm.state.value.phase)
        assertEquals(FIGURES, vm.state.value.figures)
        vm.close()
    }

    @Test fun `the identity names the account by its display name when it has one`() = runTest(dispatcher) {
        val named = testSession.copy(user = testSession.user.copy(displayName = "Jana Dvořák"))
        val vm = viewModel(ScriptedProfileAccount(), FakeAuthRepository(initial = SessionStatus.SignedIn(named)))
        assertEquals("Jana Dvořák", vm.state.value.name)
        assertEquals("a@b.cz", vm.state.value.email)
        vm.close()
    }

    @Test fun `without a session there is no identity and nothing to send`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = viewModel(ScriptedProfileAccount(), auth)
        runCurrent()
        assertNull(vm.state.value.email)
        vm.onAction(ProfileAction.RequestPasswordReset)
        runCurrent()
        assertEquals(ProfileResetPhase.IDLE, vm.state.value.resetPhase)
        assertTrue(auth.resets.isEmpty())
        vm.close()
    }

    @Test fun `a failed summary keeps the identity and retry recovers`() = runTest(dispatcher) {
        val account = ScriptedProfileAccount(
            summary = listOf(
                { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
                { RepositoryResult.Content(SUMMARY) },
            ),
        )
        val vm = viewModel(account)
        runCurrent()
        assertEquals(ProfilePhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        assertEquals("a@b.cz", vm.state.value.email)
        vm.onAction(ProfileAction.Retry)
        assertEquals(ProfilePhase.LOADING, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        runCurrent()
        assertEquals(FIGURES, vm.state.value.figures)
        assertEquals(2, account.summaries.calls)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedProfileAccount(summary = listOf(crashes())))
        runCurrent()
        assertEquals(ProfilePhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a newer load cancels the one before and an answer that comes late is not published`() =
        runTest(dispatcher) {
            val gate = CompletableDeferred<Unit>()
            val account = ScriptedProfileAccount(
                summary = listOf(
                    answersLate(gate, RepositoryResult.Content(SUMMARY.copy(problemCount = 99))),
                    { RepositoryResult.Content(SUMMARY) },
                ),
            )
            val vm = viewModel(account)
            runCurrent()
            vm.onAction(ProfileAction.Retry)
            runCurrent()
            gate.complete(Unit)
            runCurrent()
            assertEquals(3, vm.state.value.figures?.problemCount)
            vm.close()
        }

    @Test fun `opening a row raises its page exactly once`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedProfileAccount())
        AccountPage.entries.forEach { vm.onAction(ProfileAction.Open(it)) }
        val first = mutableListOf<ProfileEffect>()
        val collector = launch { vm.effects.collect { first += it } }
        runCurrent()
        collector.cancel()
        val again = mutableListOf<ProfileEffect>()
        val second = launch { vm.effects.collect { again += it } }
        runCurrent()
        second.cancel()
        assertEquals(AccountPage.entries.map<AccountPage, ProfileEffect> { ProfileEffect.Open(it) }, first)
        assertTrue(again.isEmpty())
        vm.close()
    }

    @Test fun `a language the server offers is saved and shown`() = runTest(dispatcher) {
        val account = ScriptedProfileAccount()
        val vm = viewModel(account)
        runCurrent()
        vm.onAction(ProfileAction.ChangeLocale("en"))
        assertTrue(vm.state.value.localeSaving)
        runCurrent()
        assertEquals("en", vm.state.value.locale)
        assertEquals(false, vm.state.value.localeSaving)
        assertEquals(listOf("en"), account.asked)
        vm.close()
    }

    @Test fun `the current language an unknown one and a second change while saving are ignored`() =
        runTest(dispatcher) {
            val account = ScriptedProfileAccount(locale = listOf(neverAnswers()))
            val vm = viewModel(account)
            runCurrent()
            vm.onAction(ProfileAction.ChangeLocale("cs"))
            vm.onAction(ProfileAction.ChangeLocale("de"))
            runCurrent()
            assertTrue(account.asked.isEmpty())
            vm.onAction(ProfileAction.ChangeLocale("en"))
            runCurrent()
            vm.onAction(ProfileAction.ChangeLocale("en"))
            runCurrent()
            assertEquals(listOf("en"), account.asked)
            vm.close()
        }

    @Test fun `a refused language keeps the old one and says why until dismissed`() = runTest(dispatcher) {
        val account = ScriptedProfileAccount(locale = listOf({ RepositoryResult.Failure(FailureKind.REJECTED) }))
        val vm = viewModel(account)
        runCurrent()
        vm.onAction(ProfileAction.ChangeLocale("en"))
        runCurrent()
        assertEquals("cs", vm.state.value.locale)
        assertEquals(Failed(FailureKind.REJECTED), vm.state.value.writeFailure)
        vm.onAction(ProfileAction.DismissFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `the reset link is sent to the address of the session and the result is shown`() =
        runTest(dispatcher) {
            val auth = FakeAuthRepository(initial = signedIn)
            val vm = viewModel(ScriptedProfileAccount(), auth)
            runCurrent()
            vm.onAction(ProfileAction.RequestPasswordReset)
            assertEquals(ProfileResetPhase.SENDING, vm.state.value.resetPhase)
            runCurrent()
            assertEquals(ProfileResetPhase.SENT, vm.state.value.resetPhase)
            assertEquals(listOf("https://s.example" to "a@b.cz"), auth.resets)
            vm.close()
        }

    @Test fun `a refused reset link is shown as failed and a second tap while sending does nothing`() =
        runTest(dispatcher) {
            val auth =
                FakeAuthRepository(initial = signedIn, resetAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
            val vm = viewModel(ScriptedProfileAccount(), auth)
            runCurrent()
            vm.onAction(ProfileAction.RequestPasswordReset)
            vm.onAction(ProfileAction.RequestPasswordReset)
            runCurrent()
            assertEquals(ProfileResetPhase.FAILED, vm.state.value.resetPhase)
            assertEquals(1, auth.resets.size)
            vm.close()
        }

    @Test fun `signing out ends the session of this device`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(initial = signedIn)
        val vm = viewModel(ScriptedProfileAccount(), auth)
        runCurrent()
        vm.onAction(ProfileAction.SignOut)
        runCurrent()
        assertEquals(1, auth.signOuts)
        vm.close()
    }

    @Test fun `closing ignores every action and cancels the work in flight`() = runTest(dispatcher) {
        val account = ScriptedProfileAccount(summary = listOf(neverAnswers()))
        val auth = FakeAuthRepository(initial = signedIn)
        val vm = viewModel(account, auth)
        runCurrent()
        vm.close()
        runCurrent()
        assertEquals(1, account.summaries.cancellations)
        val before = vm.state.value
        vm.onAction(ProfileAction.Retry)
        vm.onAction(ProfileAction.ChangeLocale("en"))
        vm.onAction(ProfileAction.SignOut)
        runCurrent()
        assertEquals(before, vm.state.value)
        assertEquals(1, account.summaries.calls)
        assertEquals(0, auth.signOuts)
        assertTrue(vm.effects.toList().isEmpty())
    }

    @Test fun `clearing the store ends the work like close does`() = runTest(dispatcher) {
        val account = ScriptedProfileAccount(summary = listOf(neverAnswers()))
        val store = ViewModelStore()
        val vm = store.provide {
            accountFactory(account, FakeAuthRepository()).profileViewModel()
        }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, account.summaries.cancellations)
    }
}
