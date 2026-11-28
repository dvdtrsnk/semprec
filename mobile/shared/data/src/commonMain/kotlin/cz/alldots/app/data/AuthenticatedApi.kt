package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.SessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.ItemChanges
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
 *
 * With [offline], a read of the offline set ([OfflineRoutes]) is answered by that layer, from what the device keeps
 * or from the server (docs/adr/2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind.md), and a write of a queued
 * route ([QueuedRoute]) is sent or queued by it (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-
 * connection.md); the window's [AuthenticatedApi] sends what the layer replays, and the Inbox captures its outbox keeps
 * ([CaptureOutbox]). Every other request still goes to the server, and the layer learns from its outcome whether the
 * server was reached and whether a write may have changed what it keeps.
 *
 * A window's api ([takesOverSender] `true`) attaches its sender to [offline] and replaces the one attached before; an
 * entry without a window (`false`, `InboxCaptureSDK`) attaches its sender only when none is attached yet
 * (docs/adr/2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk.md).
 */
class AuthenticatedApi(
    private val client: ApiClient,
    private val storage: SessionStorage,
    val changes: ItemChanges = ItemChanges(),
    internal val offline: OfflineLayer? = null,
    takesOverSender: Boolean = true,
    private val onSessionRejected: suspend () -> Unit,
) {
    /**
     * Sends what the offline layer keeps (the queued writes, the note pages and the Inbox captures), with the session
     * signed in when each request goes out; a `401` signs the window out, as for [send].
     */
    private val queueSender = object : QueueSender {
        override fun account(): String? = storage.load()?.let(::accountKey)

        override fun session(): StoredSession? = storage.load()

        override suspend fun send(request: ApiRequest): ApiResponse {
            val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
            val response = transmit(session, request)
            if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
            return response
        }

        override suspend fun upload(path: String, body: RawBody): ApiResponse {
            val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
            val response = client.upload(session.serverUrl, path, session.token, body, emptyList())
            if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
            return response
        }
    }

    init {
        if (takesOverSender) offline?.writes?.attach(queueSender) else offline?.writes?.attachIfNone(queueSender)
    }

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
        val request = ApiRequest(method, path, query, body, extraHeaders, bodyContentType, requestTimeoutMillis)
        val queued = QueuedRoute.of(method, path)
        val response = when {
            offline == null -> transmit(session, request)
            OfflineRoutes.keeps(method, path) -> offline.read(session, request) { transmit(session, it) }
            queued != null -> offline.write(session, queued, request) { transmit(session, it) }
            else -> transmit(session, request).also { sent ->
                if (sent is ApiResponse.Success && OfflineRoutes.changesKept(method, path)) {
                    offline.wrote()
                } else {
                    offline.observed(sent)
                }
            }
        }
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        if (response is ApiResponse.Success && announces(method, path)) changes.announce()
        return response
    }

    private suspend fun transmit(session: StoredSession, request: ApiRequest): ApiResponse = client.send(
        session.serverUrl,
        request.method,
        request.path,
        session.token,
        request.query,
        request.body,
        request.extraHeaders,
        request.bodyContentType,
        request.requestTimeoutMillis,
    )

    /** Uploads [body] as the raw body of a `POST`; its media type is the `Content-Type` of the request. */
    suspend fun upload(path: String, body: RawBody, extraHeaders: List<Pair<String, String>>): ApiResponse {
        val session = storage.load() ?: return ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.upload(session.serverUrl, path, session.token, body, extraHeaders)
        if (response is ApiResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        if (response is ApiResponse.Success && announces(HttpMethod.Post, path)) changes.announce()
        return response
    }

    /** Reads the bytes at [path]; [maxBytes] and [requestTimeoutMillis] bound the read ([ApiClient.download]). */
    suspend fun download(path: String, maxBytes: Long? = null, requestTimeoutMillis: Long? = null): ApiBytesResponse {
        val session = storage.load() ?: return ApiBytesResponse.Failure(FailureKind.UNAUTHORIZED, null)
        val response = client.download(session.serverUrl, path, session.token, maxBytes, requestTimeoutMillis)
        if (response is ApiBytesResponse.Failure && response.status == UNAUTHORIZED_STATUS) onSessionRejected()
        return response
    }

    /**
     * Opens the WebSocket [path] with the stored session and runs [session] on it (see [ApiClient.openSocket]), and
     * returns how it ended. It returns `null`, and nothing should reconnect, when nobody is signed in (nothing is
     * opened) or when the server refused the session; then [onSessionRejected] has run, as for a `401` of [send].
     * The server refuses it by closing the socket with [SESSION_REVOKED_CLOSE_CODE], or by answering the handshake
     * with `401`. A failed handshake does not say which status it got on every engine, so after one the session is
     * checked with `GET /api/auth/session`, whose `401` is the refusal.
     */
    suspend fun openSocket(path: String, session: suspend (DefaultClientWebSocketSession) -> Unit): SocketEnd? {
        val stored = storage.load() ?: return null
        var opened = false
        val end = client.openSocket(stored.serverUrl, path, stored.token) { socket ->
            opened = true
            session(socket)
        }
        val rejected = when {
            end is SocketEnd.Closed && end.code == SESSION_REVOKED_CLOSE_CODE -> {
                onSessionRejected()
                true
            }
            end is SocketEnd.Failed && !opened -> sessionRefused()
            else -> false
        }
        return end.takeUnless { rejected }
    }

    /** Whether the session check answers `401`; [send] has then run [onSessionRejected]. */
    private suspend fun sessionRefused(): Boolean {
        val check = send(HttpMethod.Get, SESSION_PATH)
        return check is ApiResponse.Failure && check.status == UNAUTHORIZED_STATUS
    }

    internal companion object {
        const val UNAUTHORIZED_STATUS = 401

        /** Answers `401` for a session the server no longer knows. */
        const val SESSION_PATH = "/api/auth/session"

        /** The close code of `WS /api/sync` for a revoked session, outside the range the protocol reserves. */
        const val SESSION_REVOKED_CLOSE_CODE: Short = 4401

        /**
         * Whether a successful [method] on [path] changed what a screen shows. Reads are not changes, nor are the
         * `POST`s that only read (a query, a count, the facet counts of a collection, a search, the preview of a project's mail signals), the raw
         * staging of a blob (the item it belongs to is created by a later request), the saving of a page's own text
         * (the diary's day page, which its load ensures with a `PUT`, and an item's `page.md`), which no list shows,
         * and the history upload of a mailbox (`history-index`), whose leases change nothing shown and whose slices,
         * every few seconds while it runs, add only history older than the 90 days the server imports itself.
         */
        fun announces(method: HttpMethod, path: String): Boolean {
            if (method == HttpMethod.Get || method == HttpMethod.Head) return false
            val route = path.substringBefore('?')
            return !(
                route.endsWith("/query") ||
                    route.endsWith("/count") ||
                    route.endsWith("/facets") ||
                    route.endsWith("/signals/preview") ||
                    route.startsWith("/api/search") ||
                    route == "/api/blobs" ||
                    route.endsWith("/doc") ||
                    route.endsWith("/page.md") ||
                    route.contains("/history-index")
                )
        }
    }
}
