package cz.semprec.app.data

import cz.semprec.app.core.DeviceInfo
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.AuthRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Session
import cz.semprec.app.domain.SessionStatus
import io.ktor.http.HttpMethod
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString

/** The session of this device, kept in [storage] and checked against the server. */
class HttpAuthRepository(
    private val client: ApiClient,
    private val storage: SessionStorage,
    private val device: DeviceInfo,
) : AuthRepository {
    private val mutableStatus = MutableStateFlow<SessionStatus>(SessionStatus.Restoring)
    override val status: StateFlow<SessionStatus> = mutableStatus.asStateFlow()

    /** The calls of the signed-in person; a rejected session signs this device out. */
    val api = AuthenticatedApi(client, storage, onSessionRejected = ::forget)

    override suspend fun restore() {
        val stored = storage.load()
        if (stored == null) {
            mutableStatus.value = SessionStatus.SignedOut
            return
        }
        val response = client.send(stored.serverUrl, HttpMethod.Get, SESSION_PATH, stored.token)
        mutableStatus.value = when (response) {
            is ApiResponse.Success -> response.readSession(stored.serverUrl)
            is ApiResponse.Failure -> when (response.kind) {
                FailureKind.UNAVAILABLE -> SessionStatus.Unreachable(stored.serverUrl)
                else -> {
                    storage.save(null)
                    SessionStatus.SignedOut
                }
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
                storage.save(StoredSession(serverUrl, login.value.token))
                val session = Session(serverUrl, login.value.user.toDomain())
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
        if (stored != null) client.send(stored.serverUrl, HttpMethod.Post, LOGOUT_PATH, stored.token)
    }

    private fun forget() {
        storage.save(null)
        mutableStatus.value = SessionStatus.SignedOut
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
        const val SESSION_PATH = "/api/auth/session"
        const val LOGIN_PATH = "/api/auth/login"
        const val LOGOUT_PATH = "/api/auth/logout"
        const val RESET_PATH = "/api/auth/password-reset/request"
    }
}
