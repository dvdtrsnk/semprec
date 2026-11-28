package cz.alldots.app.domain

import kotlinx.coroutines.flow.StateFlow

/** The session of this device and the calls that change it. */
interface AuthRepository {
    /** The current session status; every change of it is published here. */
    val status: StateFlow<SessionStatus>

    /** Checks the stored session against the server; ends in [SessionStatus.SignedIn] or [SessionStatus.SignedOut]. */
    suspend fun restore()

    /** Signs in with a password. A refusal is [cz.alldots.app.core.FailureKind.UNAUTHORIZED]. */
    suspend fun signIn(serverUrl: String, email: String, password: String): RepositoryResult<Session>

    /** Asks the server to send a reset link to [email]; the answer never says whether the address is known. */
    suspend fun requestPasswordReset(serverUrl: String, email: String): RepositoryResult<Unit>

    /** Ends the session on the server where possible and always forgets it on this device. */
    suspend fun signOut()
}
