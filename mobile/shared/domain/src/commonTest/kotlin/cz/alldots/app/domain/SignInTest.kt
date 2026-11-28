package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Records every call and answers [resetAnswer] to a password reset. */
internal class RecordingAuth(
    var resetAnswer: RepositoryResult<PasswordResetOutcome> = RepositoryResult.Content(PasswordResetOutcome.Done),
) : AuthRepository {
    override val status: StateFlow<SessionStatus> = MutableStateFlow(SessionStatus.SignedOut)
    val signIns = mutableListOf<Triple<String, String, String>>()
    val resets = mutableListOf<Pair<String, String>>()
    val passwordResets = mutableListOf<Triple<String, String, String>>()
    override suspend fun restore() = Unit
    override suspend fun signIn(serverUrl: String, email: String, password: String): RepositoryResult<Session> {
        signIns += Triple(serverUrl, email, password)
        return RepositoryResult.Content(Session(serverUrl, SessionUser("u", email, "cs", "member")))
    }
    override suspend fun requestPasswordReset(serverUrl: String, email: String): RepositoryResult<Unit> {
        resets += serverUrl to email
        return RepositoryResult.Content(Unit)
    }
    override suspend fun resetPassword(
        serverUrl: String,
        token: String,
        newPassword: String,
    ): RepositoryResult<PasswordResetOutcome> {
        passwordResets += Triple(serverUrl, token, newPassword)
        return resetAnswer
    }
    override suspend fun signOut() = Unit
}

class SignInTest {
    @Test fun `passes a normalized server and a trimmed address to the repository`() = runTest {
        val auth = RecordingAuth()
        SignIn(auth)("alldots.example/", " a@b.cz ", " secret ")
        assertEquals(listOf(Triple("https://alldots.example", "a@b.cz", " secret ")), auth.signIns)
    }

    @Test fun `a blank address or password or server is rejected before any request`() = runTest {
        val auth = RecordingAuth()
        for ((server, email, password) in listOf(
            Triple("alldots.example", "", "secret"),
            Triple("alldots.example", "a@b.cz", ""),
            Triple("", "a@b.cz", "secret"),
        )) {
            val result = SignIn(auth)(server, email, password)
            assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
        }
        assertTrue(auth.signIns.isEmpty())
    }

    @Test fun `a reset needs an address and a readable server`() = runTest {
        val auth = RecordingAuth()
        assertIs<RepositoryResult.Failure>(RequestPasswordReset(auth)("alldots.example", " "))
        assertIs<RepositoryResult.Failure>(RequestPasswordReset(auth)("", "a@b.cz"))
        assertIs<RepositoryResult.Content<Unit>>(RequestPasswordReset(auth)("alldots.example", " a@b.cz "))
        assertEquals(listOf("https://alldots.example" to "a@b.cz"), auth.resets)
    }
}
