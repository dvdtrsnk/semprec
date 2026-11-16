package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.StoredSession
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod

/**
 * The calls of a signed-in person: every request goes to the stored server with the stored token. A `401` means
 * the server no longer knows the session, so [onSessionRejected] runs once before the failure is returned.
 */
class AuthenticatedApi(
    private val client: ApiClient,
    private val storage: SessionStorage,
    private val onSessionRejected: () -> Unit,
) {
    /** The session the calls go out with, or `null` when nobody is signed in. */
    fun session(): StoredSession? = storage.load()

    suspend fun send(
        method: HttpMethod,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        extraHeaders: List<Pair<String, String>> = emptyList(),
        bodyContentType: ContentType = ContentType.Application.Json,
    ): ApiResponse {
        val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.send(
            session.serverUrl, method, path, session.token, query, body, extraHeaders, bodyContentType,
        )
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        return response
    }

    /** Uploads [body] as the raw body of a `POST`; its media type is the `Content-Type` of the request. */
    suspend fun upload(path: String, body: RawBody, extraHeaders: List<Pair<String, String>>): ApiResponse {
        val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.upload(session.serverUrl, path, session.token, body, extraHeaders)
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        return response
    }

    suspend fun download(path: String): ApiBytesResponse {
        val session = storage.load() ?: return ApiBytesResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.download(session.serverUrl, path, session.token)
        if (response is ApiBytesResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        return response
    }

    private companion object {
        const val UNAUTHORIZED_STATUS = 401
    }
}
