package cz.semprec.app.presentation

import cz.semprec.app.domain.SessionStatus
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class SessionViewModelTest : MainDispatcherTest() {
    @Test fun `restores the stored session when it starts`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(restoreTo = SessionStatus.SignedIn(testSession))
        val vm = factory(FakeRepository(catalog), auth).sessionViewModel()
        assertEquals(SessionState(), vm.state.value)
        runCurrent()
        assertEquals(SessionState(SessionPhase.SIGNED_IN, "a@b.cz", "member", "https://s.example"), vm.state.value)
        assertEquals(1, auth.restores)
        vm.close()
    }

    @Test fun `nothing stored means signed out`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog), FakeAuthRepository()).sessionViewModel()
        runCurrent()
        assertEquals(SessionState(SessionPhase.SIGNED_OUT), vm.state.value)
        vm.close()
    }

    @Test fun `an unreachable server keeps the wait and retry checks again`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(restoreTo = SessionStatus.Unreachable("https://s.example"))
        val vm = factory(FakeRepository(catalog), auth).sessionViewModel()
        runCurrent()
        assertEquals(SessionState(SessionPhase.UNREACHABLE, serverUrl = "https://s.example"), vm.state.value)
        auth.restoreTo = SessionStatus.SignedIn(testSession)
        vm.onAction(SessionAction.Retry)
        runCurrent()
        assertEquals(SessionPhase.SIGNED_IN, vm.state.value.phase)
        assertEquals(2, auth.restores)
        vm.close()
    }

    @Test fun `a sign in elsewhere moves the session to signed in`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = factory(FakeRepository(catalog), auth).sessionViewModel()
        runCurrent()
        auth.signIn("https://s.example", "a@b.cz", "secret")
        runCurrent()
        assertEquals(SessionPhase.SIGNED_IN, vm.state.value.phase)
        vm.close()
    }

    @Test fun `sign out ends the session`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(restoreTo = SessionStatus.SignedIn(testSession))
        val vm = factory(FakeRepository(catalog), auth).sessionViewModel()
        runCurrent()
        vm.onAction(SessionAction.SignOut)
        runCurrent()
        assertEquals(SessionPhase.SIGNED_OUT, vm.state.value.phase)
        assertEquals(1, auth.signOuts)
        vm.close()
    }

    @Test fun `a closed view model ignores actions`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(restoreTo = SessionStatus.SignedIn(testSession))
        val vm = factory(FakeRepository(catalog), auth).sessionViewModel()
        runCurrent()
        vm.close()
        vm.close()
        vm.onAction(SessionAction.SignOut)
        runCurrent()
        assertEquals(0, auth.signOuts)
        assertEquals(SessionPhase.SIGNED_IN, vm.state.value.phase)
    }
}
