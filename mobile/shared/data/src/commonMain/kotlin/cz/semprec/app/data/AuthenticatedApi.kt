package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.ItemChanges
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod

/**
 * The calls of a signed-in person: every request goes to the stored server with the stored token. A `401` means
 * the server no longer knows the session, so [onSessionRejected] runs once before the failure is returned.
 *
 * Every successful write is announced on [changes], so that the open screens of the window load again
 * (docs/adr/2026-11-16-open-mobile-screens-reload-after-any-write-of-their-window.md): a request other than a `GET`,
 * except those that only read or only save the text of a page, which [announces] lists.
 */
class AuthenticatedApi(
    private val client: ApiClient,
    private val storage: SessionStorage,
    val changes: ItemChanges = ItemChanges(),
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
        requestTimeoutMillis: Long? = null,
    ): ApiResponse {
        val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.send(
            session.serverUrl, method, path, session.token, query, body, extraHeaders, bodyContentType,
            requestTimeoutMillis,
        )
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        if (response is ApiResponse.Success && announces(method, path)) changes.announce()
        return response
    }

    /** Uploads [body] as the raw body of a `POST`; its media type is the `Content-Type` of the request. */
    suspend fun upload(path: String, body: RawBody, extraHeaders: List<Pair<String, String>>): ApiResponse {
        val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.upload(session.serverUrl, path, session.token, body, extraHeaders)
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        if (response is ApiResponse.Success && announces(HttpMethod.Post, path)) changes.announce()
        return response
    }

    suspend fun download(path: String): ApiBytesResponse {
        val session = storage.load() ?: return ApiBytesResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.download(session.serverUrl, path, session.token)
        if (response is ApiBytesResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        return response
    }

    /**
     * Opens the WebSocket [path] with the stored session and runs [session] on it (see [ApiClient.openSocket]), or
     * returns `null` without opening anything when nobody is signed in. A socket the server closes because it revoked
     * the session ([SESSION_REVOKED_CLOSE_CODE]) runs [onSessionRejected], as a `401` does.
     */
    suspend fun openSocket(path: String, session: suspend (DefaultClientWebSocketSession) -> Unit): SocketEnd? {
        val stored = storage.load() ?: return null
        val end = client.openSocket(stored.serverUrl, path, stored.token, session)
        if (end is SocketEnd.Closed && end.code == SESSION_REVOKED_CLOSE_CODE) onSessionRejected()
        return end
    }

    internal companion object {
        const val UNAUTHORIZED_STATUS = 401

        /** The close code of `WS /api/sync` for a revoked session, outside the range the protocol reserves. */
        const val SESSION_REVOKED_CLOSE_CODE: Short = 4401

        /**
         * Whether a successful [method] on [path] changed what a screen shows. Reads are not changes, nor are the
         * `POST`s that only read (a query, a count, a search), the raw staging of a blob (the item it belongs to is
         * created by a later request), the saving of a page's own text (the diary's day page, which its load
         * ensures with a `PUT`, and an item's `page.md`), which no list shows, and the history upload of a mailbox
         * (`history-index`), whose leases change nothing shown and whose slices, every few seconds while it runs,
         * add only history older than the 90 days the server imports itself.
         */
        fun announces(method: HttpMethod, path: String): Boolean {
            if (method == HttpMethod.Get || method == HttpMethod.Head) return false
            val route = path.substringBefore('?')
            return !(
                route.endsWith("/query") ||
                    route.endsWith("/count") ||
                    route.startsWith("/api/search") ||
                    route == "/api/blobs" ||
                    route.endsWith("/doc") ||
                    route.endsWith("/page.md") ||
                    route.contains("/history-index")
                )
        }
    }
}
