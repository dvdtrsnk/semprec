package cz.semprec.app.domain

/** Who is signed in. [role] is `admin` or `member`; [locale] is the language the server answers in. */
data class SessionUser(val id: String, val email: String, val locale: String, val role: String)

/** A signed-in session: the server it belongs to and the person it belongs to. */
data class Session(val serverUrl: String, val user: SessionUser)

/** Whether this device holds a usable session. [Restoring] lasts until the stored session was checked. */
sealed interface SessionStatus {
    data object Restoring : SessionStatus
    data object SignedOut : SessionStatus

    /** A stored session exists but the server could not be reached to check it; the token is kept. */
    data class Unreachable(val serverUrl: String) : SessionStatus

    data class SignedIn(val session: Session) : SessionStatus
}
