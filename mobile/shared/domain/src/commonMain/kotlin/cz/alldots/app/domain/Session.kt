package cz.alldots.app.domain

/**
 * Who is signed in. [role] is `admin` or `member`; [locale] is the language the server answers in; [displayName] is
 * the name the person gave their account, `null` when they gave none.
 */
data class SessionUser(
    val id: String,
    val email: String,
    val locale: String,
    val role: String,
    val displayName: String? = null,
)

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
