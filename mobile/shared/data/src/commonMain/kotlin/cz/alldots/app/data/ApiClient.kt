package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.prepareRequest
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentLength
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.utils.io.readRemaining
import io.ktor.websocket.CloseReason
import io.ktor.websocket.close
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.io.readByteArray

private const val REQUEST_TIMEOUT_MILLIS = 30_000L
private const val CONNECT_TIMEOUT_MILLIS = 15_000L
// A recording of an hour is tens of megabytes; its upload gets far longer than a JSON call.
private const val UPLOAD_TIMEOUT_MILLIS = 600_000L
private const val DEFAULT_MEDIA_TYPE = "application/octet-stream"
// How long a socket may take to open, and how long its closing handshake may take when the caller ends it.
private const val SOCKET_HANDSHAKE_TIMEOUT_MILLIS = 15_000L
private const val SOCKET_CLOSE_TIMEOUT_MILLIS = 2_000L

/** How a WebSocket that [ApiClient.openSocket] opened ended. */
sealed interface SocketEnd {
    /** The server closed it with [code], or the connection ended without a close frame (`null`). */
    data class Closed(val code: Short?) : SocketEnd

    /** It could not be opened, or the connection failed while it was open. */
    data object Failed : SocketEnd
}

/** The raw bytes of a request body and the media type they are sent as. */
class RawBody(val mimeType: String, val bytes: ByteArray)

/**
 * The only code that opens a connection to a Alldots server. It sends JSON, attaches the bearer token when it has
 * one, and turns every status or transport problem into a [FailureKind]; cancellation is rethrown, never mapped. It
 * also opens the sync WebSocket ([openSocket]), whose end is a [SocketEnd] value in the same way.
 */
class ApiClient internal constructor(engine: HttpClientEngine?) {
    /** A client on the platform's default engine. */
    constructor() : this(null)

    private val http: HttpClient = if (engine == null) HttpClient(configuration) else HttpClient(engine, configuration)

    /**
     * Sends one request to [serverUrl] (`https://host`, no trailing slash). [body] is a JSON document, or `null`
     * for none, unless [bodyContentType] names another media type (the Markdown of a page); [query] values are
     * encoded by Ktor and [extraHeaders] are added as they are (`If-Match`). [requestTimeoutMillis] replaces the
     * default bound for a request the server answers only after slow work of its own.
     */
    suspend fun send(
        serverUrl: String,
        method: HttpMethod,
        path: String,
        token: String? = null,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        extraHeaders: List<Pair<String, String>> = emptyList(),
        bodyContentType: ContentType = ContentType.Application.Json,
        requestTimeoutMillis: Long? = null,
    ): ApiResponse = try {
        http.prepareRequest {
            this.method = method
            url("$serverUrl$path")
            if (requestTimeoutMillis != null) timeout { this.requestTimeoutMillis = requestTimeoutMillis }
            query.forEach { (name, value) -> url.parameters.append(name, value) }
            headers(token)
            extraHeaders.forEach { (name, value) -> header(name, value) }
            if (body != null) {
                contentType(bodyContentType)
                setBody(body)
            }
        }.execute { response ->
            val failure = failureKind(response.status)
            if (failure == null) {
                ApiResponse.Success(response.status.value, response.bodyAsText(), response.headers[HttpHeaders.ETag])
            } else {
                ApiResponse.Failure(failure, response.status.value, errorBody(response))
            }
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
    }

    /** Sends [bytes] as the raw body of a `POST`, as the upload routes expect, and reads the JSON answer. */
    suspend fun upload(
        serverUrl: String,
        path: String,
        token: String?,
        body: RawBody,
        extraHeaders: List<Pair<String, String>>,
    ): ApiResponse = try {
        http.prepareRequest {
            method = HttpMethod.Post
            url("$serverUrl$path")
            headers(token)
            extraHeaders.forEach { (name, value) -> header(name, value) }
            contentType(ContentType.parse(body.mimeType))
            timeout { requestTimeoutMillis = UPLOAD_TIMEOUT_MILLIS }
            setBody(body.bytes)
        }.execute { response ->
            val failure = failureKind(response.status)
            if (failure == null) ApiResponse.Success(response.status.value, response.bodyAsText())
            else ApiResponse.Failure(failure, response.status.value)
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
    }

    /**
     * The body of an error answer, or `null` when it cannot be read: the status alone still decides the failure, so
     * a `401` whose body breaks off stays a `401`.
     */
    private suspend fun errorBody(response: HttpResponse): String? = try {
        response.bodyAsText()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    /**
     * Reads the bytes of a `GET`, with the media type the server named. With [maxBytes] a body longer than that is
     * read no further than one byte past it and fails as [FailureKind.INVALID_DATA]; [requestTimeoutMillis] replaces
     * the default bound.
     */
    suspend fun download(
        serverUrl: String,
        path: String,
        token: String?,
        maxBytes: Long? = null,
        requestTimeoutMillis: Long? = null,
    ): ApiBytesResponse = try {
        http.prepareRequest {
            method = HttpMethod.Get
            url("$serverUrl$path")
            if (requestTimeoutMillis != null) timeout { this.requestTimeoutMillis = requestTimeoutMillis }
            if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
        }.execute { response ->
            val failure = failureKind(response.status)
            val bytes = if (failure == null) bodyBytes(response, maxBytes) else null
            val type = response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim()
            when {
                failure != null -> ApiBytesResponse.Failure(failure, response.status.value)
                bytes == null -> ApiBytesResponse.Failure(FailureKind.INVALID_DATA, response.status.value)
                else -> ApiBytesResponse.Success(response.status.value, type ?: DEFAULT_MEDIA_TYPE, bytes)
            }
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ApiBytesResponse.Failure(FailureKind.UNAVAILABLE, null)
    }

    /** The body of [response], or `null` when it is longer than [maxBytes]; read no further than one byte beyond. */
    private suspend fun bodyBytes(response: HttpResponse, maxBytes: Long?): ByteArray? = when {
        maxBytes == null -> response.bodyAsBytes()
        (response.contentLength() ?: 0L) > maxBytes -> null
        else -> response.bodyAsChannel().readRemaining(maxBytes + 1).readByteArray().takeIf { it.size <= maxBytes }
    }

    /**
     * Opens the WebSocket [path] of [serverUrl] (`https://host` becomes `wss://host`) with the bearer [token] and runs
     * [session] on it until it returns, then reports how the socket ended. The handshake is bounded. When the caller
     * is cancelled, the socket sends a normal close frame and waits, bounded, for the server's answer before the
     * cancellation is rethrown.
     */
    suspend fun openSocket(
        serverUrl: String,
        path: String,
        token: String,
        session: suspend (DefaultClientWebSocketSession) -> Unit,
    ): SocketEnd {
        val stopping = CompletableDeferred<Unit>()
        // Outside the caller's job: cancelling the caller would otherwise tear the connection down before the close
        // frame is out. A supervisor, so that nothing the socket does can fail the client itself; completed at once,
        // so that it ends with the socket instead of staying a child of the client.
        val supervisor = SupervisorJob(http.coroutineContext[Job])
        val running = http.async(supervisor) {
            runSocket(socketUrl(serverUrl, path), token, session, stopping)
        }
        supervisor.complete()
        return try {
            running.await()
        } catch (cancelled: CancellationException) {
            stopping.complete(Unit)
            withContext(NonCancellable) {
                if (withTimeoutOrNull(SOCKET_CLOSE_TIMEOUT_MILLIS * 2) { running.join() } == null) running.cancel()
            }
            throw cancelled
        }
    }

    private suspend fun runSocket(
        url: String,
        token: String,
        session: suspend (DefaultClientWebSocketSession) -> Unit,
        stopping: Deferred<Unit>,
    ): SocketEnd = try {
        var end: SocketEnd = SocketEnd.Failed
        coroutineScope {
            val handshake = launch {
                delay(SOCKET_HANDSHAKE_TIMEOUT_MILLIS)
                throw SocketHandshakeTimeout()
            }
            http.webSocket(url, request = { header(HttpHeaders.Authorization, "Bearer $token") }) {
                handshake.cancel()
                val reading = launch { session(this@webSocket) }
                val stopped = select {
                    reading.onJoin { false }
                    stopping.onAwait { true }
                }
                if (stopped) reading.cancelAndJoin()
                if (stopped) close(CloseReason(CloseReason.Codes.NORMAL, "client closed"))
                end = SocketEnd.Closed(withTimeoutOrNull(SOCKET_CLOSE_TIMEOUT_MILLIS) { closeReason.await() }?.code)
            }
        }
        end
    } catch (_: CancellationException) {
        // The connection cancelled the session, unless this coroutine itself was cancelled.
        currentCoroutineContext().ensureActive()
        SocketEnd.Failed
    } catch (_: Exception) {
        SocketEnd.Failed
    }

    private fun HttpRequestBuilder.headers(token: String?) {
        header(HttpHeaders.Accept, ContentType.Application.Json.toString())
        if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
    }

    private companion object {
        val configuration: io.ktor.client.HttpClientConfig<*>.() -> Unit = {
            expectSuccess = false
            install(WebSockets)
            install(HttpTimeout) {
                requestTimeoutMillis = REQUEST_TIMEOUT_MILLIS
                connectTimeoutMillis = CONNECT_TIMEOUT_MILLIS
            }
        }
    }
}

/** The server did not complete a WebSocket handshake in time. */
private class SocketHandshakeTimeout : Exception("WebSocket handshake timed out")

/** The WebSocket URL of [path] on [serverUrl]: `https` becomes `wss` and `http` becomes `ws`. */
internal fun socketUrl(serverUrl: String, path: String): String = when {
    serverUrl.startsWith("https://") -> "wss://" + serverUrl.removePrefix("https://") + path
    serverUrl.startsWith("http://") -> "ws://" + serverUrl.removePrefix("http://") + path
    else -> serverUrl + path
}

/** The failure a status maps to, or `null` for a success. */
internal fun failureKind(status: HttpStatusCode): FailureKind? = when {
    status.isSuccess() -> null
    status == HttpStatusCode.Unauthorized || status == HttpStatusCode.Forbidden -> FailureKind.UNAUTHORIZED
    status == HttpStatusCode.NotFound -> FailureKind.NOT_FOUND
    status in REJECTED_STATUSES -> FailureKind.REJECTED
    status == HttpStatusCode.TooManyRequests || status.value >= HttpStatusCode.InternalServerError.value ->
        FailureKind.UNAVAILABLE
    else -> FailureKind.INVALID_DATA
}

private val REJECTED_STATUSES =
    setOf(HttpStatusCode.BadRequest, HttpStatusCode.Conflict, HttpStatusCode.UnprocessableEntity)
