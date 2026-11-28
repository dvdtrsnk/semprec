package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.Session
import cz.alldots.app.domain.SessionStatus
import cz.alldots.app.domain.SessionUser
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

val testSession = Session("https://s.example", SessionUser("u1", "a@b.cz", "cs", "member"))

/** Scripted auth: [signInAnswer] is what [signIn] returns, once [gate] (if set) is completed. */
class FakeAuthRepository(
    initial: SessionStatus = SessionStatus.Restoring,
    var restoreTo: SessionStatus = SessionStatus.SignedOut,
    var signInAnswer: RepositoryResult<Session> = RepositoryResult.Content(testSession),
    var resetAnswer: RepositoryResult<Unit> = RepositoryResult.Content(Unit),
    var gate: CompletableDeferred<Unit>? = null,
) : AuthRepository {
    private val mutableStatus = MutableStateFlow(initial)
    override val status: StateFlow<SessionStatus> = mutableStatus

    val signIns = mutableListOf<Triple<String, String, String>>()
    val resets = mutableListOf<Pair<String, String>>()
    var restores = 0
        private set
    var signOuts = 0
        private set

    override suspend fun restore() {
        restores += 1
        mutableStatus.value = restoreTo
    }

    override suspend fun signIn(serverUrl: String, email: String, password: String): RepositoryResult<Session> {
        signIns += Triple(serverUrl, email, password)
        gate?.await()
        val answer = signInAnswer
        if (answer is RepositoryResult.Content) mutableStatus.value = SessionStatus.SignedIn(answer.value)
        return answer
    }

    override suspend fun requestPasswordReset(serverUrl: String, email: String): RepositoryResult<Unit> {
        resets += serverUrl to email
        return resetAnswer
    }

    override suspend fun signOut() {
        signOuts += 1
        mutableStatus.value = SessionStatus.SignedOut
    }
}

val unauthorized = RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
