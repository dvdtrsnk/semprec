package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.SessionStorage
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
    suspend fun send(
        method: HttpMethod,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
    ): ApiResponse {
        val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.send(session.serverUrl, method, path, session.token, query, body)
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        return response
    }

    private companion object {
        const val UNAUTHORIZED_STATUS = 401
    }
}
