package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.RequestPasswordReset
import cz.semprec.app.domain.SignIn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The sign-in form. A successful sign-in changes the session status, which the app root observes through
 * [SessionViewModel], so this screen has no effects. While a request runs, further requests are ignored.
 */
class LoginViewModel internal constructor(
    private val signIn: SignIn,
    private val requestPasswordReset: RequestPasswordReset,
) : ScreenViewModel<LoginState, LoginAction, Nothing>(LoginState()) {
    private var job: Job? = null

    override fun onAction(action: LoginAction) {
        if (isClosed) return
        when (action) {
            LoginAction.Edited -> if (state.value.phase != LoginPhase.SIGNING_IN) {
                update { LoginState() }
            }
            is LoginAction.SignIn -> run(keepReset = false) {
                (signIn(action.server, action.email, action.password) as? RepositoryResult.Failure)?.kind
            }
            is LoginAction.ForgotPassword -> run(keepReset = true) {
                val outcome = requestPasswordReset(action.server, action.email)
                (outcome as? RepositoryResult.Failure)?.kind
            }
        }
    }

    private fun run(keepReset: Boolean, request: suspend () -> FailureKind?) {
        if (state.value.phase == LoginPhase.SIGNING_IN) return
        job?.cancel()
        update { LoginState(LoginPhase.SIGNING_IN) }
        job = viewModelScope.launch {
            val failure = try {
                request()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                FailureKind.UNAVAILABLE
            }
            ensureActive()
            update {
                when {
                    failure != null -> LoginState(LoginPhase.FAILED, failure)
                    else -> LoginState(LoginPhase.EDITING, resetRequested = keepReset)
                }
            }
        }
    }
}
