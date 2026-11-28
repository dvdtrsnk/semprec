package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.RestoreSession
import cz.alldots.app.domain.SessionStatus
import cz.alldots.app.domain.SignOut
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Mirrors the session of this device and restores the stored one at the start; the screens follow its phase. */
class SessionViewModel internal constructor(
    private val auth: AuthRepository,
    private val restoreSession: RestoreSession,
    private val signOut: SignOut,
) : ScreenViewModel<SessionState, SessionAction, Nothing>(SessionState()) {
    private var restoreJob: Job? = null

    init {
        viewModelScope.launch { auth.status.collect { status -> update { status.toState() } } }
        restore()
    }

    override fun onAction(action: SessionAction) {
        if (isClosed) return
        when (action) {
            SessionAction.Retry -> restore()
            SessionAction.SignOut -> viewModelScope.launch { signOut() }
        }
    }

    private fun restore() {
        restoreJob?.cancel()
        restoreJob = viewModelScope.launch { restoreSession() }
    }
}

private fun SessionStatus.toState(): SessionState = when (this) {
    SessionStatus.Restoring -> SessionState(SessionPhase.RESTORING)
    SessionStatus.SignedOut -> SessionState(SessionPhase.SIGNED_OUT)
    is SessionStatus.Unreachable -> SessionState(SessionPhase.UNREACHABLE, serverUrl = serverUrl)
    is SessionStatus.SignedIn ->
        SessionState(SessionPhase.SIGNED_IN, session.user.email, session.user.role, session.serverUrl)
}
