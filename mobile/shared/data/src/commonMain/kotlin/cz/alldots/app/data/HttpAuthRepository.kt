package cz.alldots.app.data

import cz.alldots.app.core.DeviceInfo
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.SessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.ItemChanges
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.Session
import cz.alldots.app.domain.SessionStatus
import io.ktor.http.HttpMethod
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString

/**
 * The session of this device, kept in [storage] and checked against the server.
 *
 * [sessionEnded] runs whenever the device drops its session: on signing out, when the server refuses the session of
 * a call (`401`), and when a restore finds that the server no longer knows the stored one. It runs once the session is
 * forgotten, so nothing it clears is written again for that session, and it runs to its end even when the call that
 * dropped the session is cancelled: what is kept on the device for the session (the thread lists) goes with it.
 *
 * [endingSession] runs on signing out only, after [sessionEnded] and before the server ends the session, with calls
 * that still carry it: what belongs to the session on the server (the push subscription of this device) is ended
 * there first.
 *
 * [changes] and [offline] are those of [api]: the window's change events and the offline layer its reads of the
 * offline set go through, if the device keeps any. With [offline], the person of every session the server confirms
 * (a restore it answered, a sign-in) is kept on the device, and a restore reports the session signed in with the
 * person kept for it before the server answers, so the app opens at once and without a connection; the answer then
 * signs the device out (a refused session) or confirms the person. Without a kept person the restore waits for the
 * answer, and one that does not come reports [SessionStatus.Unreachable].
 */
class HttpAuthRepository(
    private val client: ApiClient,
    private val storage: SessionStorage,
    private val device: DeviceInfo,
    private val sessionEnded: suspend () -> Unit = {},
    private val endingSession: suspend (AuthenticatedApi) -> Unit = {},
    changes: ItemChanges = ItemChanges(),
    private val offline: OfflineLayer? = null,
) : AuthRepository {
    private val mutableStatus = MutableStateFlow<SessionStatus>(SessionStatus.Restoring)
    override val status: StateFlow<SessionStatus> = mutableStatus.asStateFlow()

    /** The calls of the signed-in person; a rejected session signs this device out. */
    val api = AuthenticatedApi(client, storage, changes, offline, onSessionRejected = ::forget)

    override suspend fun restore() {
        val stored = storage.load()
        if (stored == null) {
            mutableStatus.value = SessionStatus.SignedOut
            return
        }
        // With a person kept for the stored session the app opens at once, signed in as that person; the server's
        // answer follows and decides as before.
        val kept = keptSession(stored)
        if (kept is SessionStatus.SignedIn) mutableStatus.value = kept
        val response = client.send(stored.serverUrl, HttpMethod.Get, AuthenticatedApi.SESSION_PATH, stored.token)
        offline?.observed(response)
        when (response) {
            is ApiResponse.Success -> {
                val restored = response.readSession(stored.serverUrl)
                if (restored is SessionStatus.SignedIn) keepPerson(stored, restored.session)
                // An answer that does not read as a session leaves an app already open as it is.
                mutableStatus.value = if (restored is SessionStatus.SignedIn) restored else kept
            }
            is ApiResponse.Failure -> when (response.kind) {
                FailureKind.UNAVAILABLE -> mutableStatus.value = keptSession(stored)
                else -> forget()
            }
        }
    }

    override suspend fun signIn(serverUrl: String, email: String, password: String): RepositoryResult<Session> {
        val request = LoginRequest(
            email = email,
            password = password,
            platform = device.platform.wireName,
            deviceId = device.deviceId,
            deviceName = device.deviceName,
            deviceKind = device.deviceKind,
            osVersion = device.osVersion,
            appVersion = device.appVersion,
        )
        val response = client.send(serverUrl, HttpMethod.Post, LOGIN_PATH, body = ApiJson.encodeToString(request))
        return when (val login = response.decode<LoginResponse>()) {
            is RepositoryResult.Failure -> RepositoryResult.Failure(login.kind.forSignIn())
            is RepositoryResult.Content -> {
                val stored = StoredSession(serverUrl, login.value.token)
                storage.save(stored)
                val session = Session(serverUrl, login.value.user.toDomain())
                keepPerson(stored, session)
                mutableStatus.value = SessionStatus.SignedIn(session)
                RepositoryResult.Content(session)
            }
        }
    }

    override suspend fun requestPasswordReset(serverUrl: String, email: String): RepositoryResult<Unit> =
        client.send(
            serverUrl,
            HttpMethod.Post,
            RESET_PATH,
            body = ApiJson.encodeToString(PasswordResetRequest(email)),
        ).ignoreBody()

    override suspend fun signOut() {
        val stored = storage.load()
        forget()
        if (stored == null) return
        val ending = InMemorySessionStorage().apply { save(stored) }
        endingSession(AuthenticatedApi(client, ending, onSessionRejected = {}))
        client.send(stored.serverUrl, HttpMethod.Post, LOGOUT_PATH, stored.token)
    }

    private suspend fun keepPerson(stored: StoredSession, session: Session) {
        offline?.store?.people?.keep(accountKey(stored), session.user)
    }

    /** The session signed in with the person kept for [stored], or unreachable when none is kept. */
    private suspend fun keptSession(stored: StoredSession): SessionStatus =
        offline?.store?.people?.person(accountKey(stored))
            ?.let { person -> SessionStatus.SignedIn(Session(stored.serverUrl, person)) }
            ?: SessionStatus.Unreachable(stored.serverUrl)

    private suspend fun forget() {
        storage.save(null)
        mutableStatus.value = SessionStatus.SignedOut
        withContext(NonCancellable) { sessionEnded() }
    }

    private fun ApiResponse.Success.readSession(serverUrl: String): SessionStatus =
        when (val read = decode<SessionResponse>()) {
            is RepositoryResult.Content -> SessionStatus.SignedIn(Session(serverUrl, read.value.user.toDomain()))
            is RepositoryResult.Failure -> SessionStatus.Unreachable(serverUrl)
        }

    /** A refused password is `401`; a `400` here means a malformed form, which the use case already ruled out. */
    private fun FailureKind.forSignIn(): FailureKind =
        if (this == FailureKind.REJECTED) FailureKind.UNAUTHORIZED else this

    private companion object {
        const val LOGIN_PATH = "/api/auth/login"
        const val LOGOUT_PATH = "/api/auth/logout"
        const val RESET_PATH = "/api/auth/password-reset/request"
    }
}
