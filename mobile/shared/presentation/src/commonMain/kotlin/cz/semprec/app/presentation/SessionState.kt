package cz.semprec.app.presentation

enum class SessionPhase { RESTORING, SIGNED_OUT, SIGNED_IN, UNREACHABLE }

/** Whether the app shows its content, the sign-in form or a wait. [email] and [role] are set while signed in. */
data class SessionState(
    val phase: SessionPhase = SessionPhase.RESTORING,
    val email: String? = null,
    val role: String? = null,
    val serverUrl: String? = null,
)
