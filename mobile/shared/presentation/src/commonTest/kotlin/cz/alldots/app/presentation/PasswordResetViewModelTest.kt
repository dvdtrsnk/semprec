package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.PasswordResetOutcome
import cz.alldots.app.domain.PasswordResetRefusal
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class PasswordResetViewModelTest : MainDispatcherTest() {
    private fun reset(auth: FakeAuthRepository): PasswordResetViewModel =
        factory(FakeRepository(catalog), auth).passwordResetViewModel("https://alldots.app", "tok-1")

    private fun refused(refusal: PasswordResetRefusal) =
        RepositoryResult.Content(PasswordResetOutcome.Refused(refusal))

    private val failed = PasswordResetPhase.FAILED

    @Test fun `starts editing with nothing to send`() = runTest(dispatcher) {
        val vm = reset(FakeAuthRepository())
        assertEquals(PasswordResetState(), vm.state.value)
        vm.close()
    }

    @Test fun `the form can be sent only while both entries are equal and not empty`() = runTest(dispatcher) {
        val vm = reset(FakeAuthRepository())
        for ((entries, canSubmit) in listOf(
            ("secret12" to "") to false,
            ("secret12" to "secret1") to false,
            ("" to "") to false,
            ("secret12" to "secret12") to true,
        )) {
            vm.onAction(PasswordResetAction.Edited(entries.first, entries.second))
            assertEquals(PasswordResetState(canSubmit = canSubmit), vm.state.value, entries.toString())
        }
        vm.close()
    }

    @Test fun `passwords that differ are not sent`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = reset(auth)
        vm.onAction(PasswordResetAction.Submit("secret12", "secret13"))
        vm.onAction(PasswordResetAction.Submit("", ""))
        runCurrent()
        assertTrue(auth.passwordResets.isEmpty())
        assertEquals(PasswordResetState(), vm.state.value)
        vm.close()
    }

    @Test fun `matching passwords set the password with the link's token at its server`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = reset(auth)
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        assertEquals(PasswordResetState(PasswordResetPhase.SENDING), vm.state.value)
        runCurrent()
        assertEquals(listOf(Triple("https://alldots.app", "tok-1", "secret12")), auth.passwordResets)
        assertEquals(PasswordResetState(PasswordResetPhase.DONE), vm.state.value)
        vm.onAction(PasswordResetAction.Edited("x", "x"))
        vm.onAction(PasswordResetAction.Submit("x", "x"))
        runCurrent()
        assertEquals(PasswordResetState(PasswordResetPhase.DONE), vm.state.value)
        assertEquals(1, auth.passwordResets.size)
        vm.close()
    }

    @Test fun `each refusal of the link is its own final state`() = runTest(dispatcher) {
        for ((refusal, reason) in listOf(
            PasswordResetRefusal.TOKEN_INVALID to PasswordResetRefusalReason.LINK_INVALID,
            PasswordResetRefusal.TOKEN_EXPIRED to PasswordResetRefusalReason.LINK_EXPIRED,
            PasswordResetRefusal.TOKEN_CONSUMED to PasswordResetRefusalReason.LINK_USED,
        )) {
            val auth = FakeAuthRepository(passwordResetAnswer = refused(refusal))
            val vm = reset(auth)
            vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
            runCurrent()
            val expected = PasswordResetState(failed, canSubmit = false, refusal = reason)
            assertEquals(expected, vm.state.value)
            vm.onAction(PasswordResetAction.Edited("other123", "other123"))
            vm.onAction(PasswordResetAction.Submit("other123", "other123"))
            runCurrent()
            assertEquals(expected, vm.state.value)
            assertEquals(1, auth.passwordResets.size)
            vm.close()
        }
    }

    @Test fun `a weak password is refused and another one can be sent with the same link`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(passwordResetAnswer = refused(PasswordResetRefusal.WEAK_PASSWORD))
        val vm = reset(auth)
        vm.onAction(PasswordResetAction.Submit("short", "short"))
        runCurrent()
        val weak = PasswordResetState(failed, canSubmit = true, refusal = PasswordResetRefusalReason.WEAK_PASSWORD)
        assertEquals(weak, vm.state.value)
        vm.onAction(PasswordResetAction.Edited("longer123", "longer123"))
        assertEquals(PasswordResetState(canSubmit = true), vm.state.value)
        auth.passwordResetAnswer = RepositoryResult.Content(PasswordResetOutcome.Done)
        vm.onAction(PasswordResetAction.Submit("longer123", "longer123"))
        runCurrent()
        assertEquals(PasswordResetState(PasswordResetPhase.DONE), vm.state.value)
        assertEquals(listOf("short", "longer123"), auth.passwordResets.map { it.third })
        vm.close()
    }

    @Test fun `any other failure keeps its kind and the form can be sent again`() = runTest(dispatcher) {
        val auth = FakeAuthRepository(passwordResetAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val vm = reset(auth)
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        runCurrent()
        assertEquals(PasswordResetState(failed, canSubmit = true, failure = FailureKind.UNAVAILABLE), vm.state.value)
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        runCurrent()
        assertEquals(2, auth.passwordResets.size)
        vm.close()
    }

    @Test fun `an unexpected exception is a failure without a kind`() = runTest(dispatcher) {
        val vm = reset(FakeAuthRepository(passwordResetError = IllegalStateException("broken")))
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        runCurrent()
        assertEquals(PasswordResetState(failed, canSubmit = true), vm.state.value)
        vm.close()
    }

    @Test fun `submits and edits while sending are ignored`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val auth = FakeAuthRepository(gate = gate)
        val vm = reset(auth)
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        runCurrent()
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        vm.onAction(PasswordResetAction.Edited("", ""))
        assertEquals(PasswordResetState(PasswordResetPhase.SENDING), vm.state.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, auth.passwordResets.size)
        assertEquals(PasswordResetPhase.DONE, vm.state.value.phase)
        vm.close()
    }

    @Test fun `close cancels the request without a failure and later actions are ignored`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val auth = FakeAuthRepository(gate = gate)
        val vm = reset(auth)
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        runCurrent()
        vm.close()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        vm.onAction(PasswordResetAction.Edited("a", "a"))
        assertEquals(PasswordResetState(PasswordResetPhase.SENDING), vm.state.value)
        assertTrue(vm.isClosed)
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val auth = FakeAuthRepository(gate = gate)
        val store = ViewModelStore()
        val vm = store.provide { reset(auth) }
        vm.onAction(PasswordResetAction.Submit("secret12", "secret12"))
        runCurrent()
        store.clear()
        gate.complete(Unit)
        runCurrent()
        vm.onAction(PasswordResetAction.Edited("a", "a"))
        assertTrue(vm.isClosed)
        assertEquals(PasswordResetState(PasswordResetPhase.SENDING), vm.state.value)
    }
}
