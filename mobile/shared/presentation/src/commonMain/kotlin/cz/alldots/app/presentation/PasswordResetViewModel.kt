package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.PasswordResetOutcome
import cz.alldots.app.domain.PasswordResetRefusal
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.ResetPassword
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * Sets a new password with the [token] of a reset link at [serverUrl], the server the link came from. It signs
 * nobody in: once the password is set the person signs in as usual, so the screen has no effects. While the
 * password is being sent, after it was set and after the server refused the link, further submits are ignored.
 */
class PasswordResetViewModel internal constructor(
    private val serverUrl: String,
    private val token: String,
    private val resetPassword: ResetPassword,
) : ScreenViewModel<PasswordResetState, PasswordResetAction, Nothing>(PasswordResetState()) {

    override fun onAction(action: PasswordResetAction) {
        if (isClosed) return
        when (action) {
            is PasswordResetAction.Edited -> if (acceptsInput()) {
                update { PasswordResetState(canSubmit = resetPassword.accepts(action.newPassword, action.repeated)) }
            }
            is PasswordResetAction.Submit -> submit(action.newPassword, action.repeated)
        }
    }

    private fun submit(newPassword: String, repeated: String) {
        if (!acceptsInput()) return
        val canSubmit = resetPassword.accepts(newPassword, repeated)
        if (!canSubmit) {
            update { PasswordResetState(canSubmit = false) }
            return
        }
        update { PasswordResetState(PasswordResetPhase.SENDING) }
        viewModelScope.launch {
            val next = try {
                stateOf(resetPassword(serverUrl, token, newPassword, repeated), canSubmit)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                PasswordResetState(PasswordResetPhase.FAILED, canSubmit)
            }
            ensureActive()
            update { next }
        }
    }

    /** Whether the form takes edits and submits: not while sending, not once set, not after the link was refused. */
    private fun acceptsInput(): Boolean {
        val current = state.value
        return when (current.phase) {
            PasswordResetPhase.SENDING, PasswordResetPhase.DONE -> false
            PasswordResetPhase.EDITING -> true
            PasswordResetPhase.FAILED -> current.refusal.allowsRetry()
        }
    }

    private fun stateOf(result: RepositoryResult<PasswordResetOutcome>, canSubmit: Boolean): PasswordResetState =
        when (result) {
            is RepositoryResult.Failure ->
                PasswordResetState(PasswordResetPhase.FAILED, canSubmit, failure = result.kind)
            is RepositoryResult.Content -> when (val outcome = result.value) {
                PasswordResetOutcome.Done -> PasswordResetState(PasswordResetPhase.DONE)
                is PasswordResetOutcome.Refused -> {
                    val reason = outcome.refusal.reason()
                    PasswordResetState(PasswordResetPhase.FAILED, canSubmit && reason.allowsRetry(), refusal = reason)
                }
            }
        }

    /** Only a refusal of the password, or a failure without one, leaves the link usable. */
    private fun PasswordResetRefusalReason?.allowsRetry(): Boolean =
        this == null || this == PasswordResetRefusalReason.WEAK_PASSWORD

    private fun PasswordResetRefusal.reason(): PasswordResetRefusalReason = when (this) {
        PasswordResetRefusal.TOKEN_INVALID -> PasswordResetRefusalReason.LINK_INVALID
        PasswordResetRefusal.TOKEN_EXPIRED -> PasswordResetRefusalReason.LINK_EXPIRED
        PasswordResetRefusal.TOKEN_CONSUMED -> PasswordResetRefusalReason.LINK_USED
        PasswordResetRefusal.WEAK_PASSWORD -> PasswordResetRefusalReason.WEAK_PASSWORD
    }
}
