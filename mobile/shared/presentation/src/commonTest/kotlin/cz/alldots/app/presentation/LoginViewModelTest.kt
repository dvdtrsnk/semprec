package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest : MainDispatcherTest() {
    private fun login(
        auth: FakeAuthRepository
    ): LoginViewModel = factory(FakeRepository(catalog), auth).loginViewModel()

    private fun signIn(server: String = "alldots.example", email: String = "a@b.cz", password: String = "secret") =
        LoginAction.SignIn(server, email, password)

    @Test fun `starts editing`() = runTest(dispatcher) {
        val vm = login(FakeAuthRepository())
        assertEquals(LoginState(), vm.state.value)
        vm.close()
    }

    @Test fun `sign in sends the normalized server and trimmed address while it signs in`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = login(auth)
        vm.onAction(signIn(email = " a@b.cz "))
        assertEquals(LoginPhase.SIGNING_IN, vm.state.value.phase)
        runCurrent()
        assertEquals(listOf(Triple("https://alldots.example", "a@b.cz", "secret")), auth.signIns)
        assertEquals(LoginState(), vm.state.value)
        vm.close()
    }

    @Test fun `an incomplete form is rejected without a request`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = login(auth)
        vm.onAction(signIn(password = ""))
        runCurrent()
        assertEquals(LoginState(LoginPhase.FAILED, FailureKind.REJECTED), vm.state.value)
        assertTrue(auth.signIns.isEmpty())
        vm.close()
    }

    @Test fun `refused credentials fail as unauthorized and an edit clears the failure`() = runTest(dispatcher) {
        val vm = login(FakeAuthRepository(signInAnswer = unauthorized))
        vm.onAction(signIn())
        runCurrent()
        assertEquals(LoginState(LoginPhase.FAILED, FailureKind.UNAUTHORIZED), vm.state.value)
        vm.onAction(LoginAction.Edited)
        assertEquals(LoginState(), vm.state.value)
        vm.close()
    }

    @Test fun `requests while one runs are ignored and an edit does not clear the wait`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val auth = FakeAuthRepository(gate = gate)
        val vm = login(auth)
        vm.onAction(signIn())
        runCurrent()
        vm.onAction(signIn())
        vm.onAction(LoginAction.ForgotPassword("alldots.example", "a@b.cz"))
        vm.onAction(LoginAction.Edited)
        assertEquals(LoginPhase.SIGNING_IN, vm.state.value.phase)
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, auth.signIns.size)
        assertTrue(auth.resets.isEmpty())
        vm.close()
    }

    @Test fun `forgot password asks for a link and an edit withdraws the notice`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = login(auth)
        vm.onAction(LoginAction.ForgotPassword("alldots.example", " a@b.cz "))
        runCurrent()
        assertEquals(listOf("https://alldots.example" to "a@b.cz"), auth.resets)
        assertEquals(LoginState(resetRequested = true), vm.state.value)
        vm.onAction(LoginAction.Edited)
        assertEquals(LoginState(), vm.state.value)
        vm.close()
    }

    @Test fun `forgot password without an address fails as rejected`() = runTest(dispatcher) {
        val vm = login(FakeAuthRepository())
        vm.onAction(LoginAction.ForgotPassword("alldots.example", ""))
        runCurrent()
        assertEquals(LoginState(LoginPhase.FAILED, FailureKind.REJECTED), vm.state.value)
        vm.close()
    }

    @Test fun `an unreachable server fails a reset as unavailable`() = runTest(dispatcher) {
        val vm = login(FakeAuthRepository(resetAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE)))
        vm.onAction(LoginAction.ForgotPassword("alldots.example", "a@b.cz"))
        runCurrent()
        assertEquals(LoginState(LoginPhase.FAILED, FailureKind.UNAVAILABLE), vm.state.value)
        vm.close()
    }

    @Test fun `close cancels a running sign in and later actions are ignored`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val auth = FakeAuthRepository(gate = gate)
        val vm = login(auth)
        vm.onAction(signIn())
        runCurrent()
        vm.close()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        vm.onAction(LoginAction.Edited)
        assertEquals(LoginPhase.SIGNING_IN, vm.state.value.phase)
    }
}
