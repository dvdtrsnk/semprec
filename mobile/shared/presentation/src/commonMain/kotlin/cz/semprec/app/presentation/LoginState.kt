package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class LoginPhase { EDITING, SIGNING_IN, FAILED }

/**
 * The sign-in form's outcome; the text being typed stays in the native fields and is handed over by
 * [LoginAction.SignIn]. [failure] explains [LoginPhase.FAILED]: [FailureKind.REJECTED] is an incomplete form,
 * [FailureKind.UNAUTHORIZED] refused credentials, [FailureKind.UNAVAILABLE] a server that could not be reached.
 * [resetRequested] is `true` once a reset link was asked for.
 */
data class LoginState(
    val phase: LoginPhase = LoginPhase.EDITING,
    val failure: FailureKind? = null,
    val resetRequested: Boolean = false,
)
