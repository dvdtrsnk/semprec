package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException

private const val REQUEST_TIMEOUT_MILLIS = 30_000L
private const val CONNECT_TIMEOUT_MILLIS = 15_000L
// A recording of an hour is tens of megabytes; its upload gets far longer than a JSON call.
private const val UPLOAD_TIMEOUT_MILLIS = 600_000L
private const val DEFAULT_MEDIA_TYPE = "application/octet-stream"

/** The raw bytes of a request body and the media type they are sent as. */
class RawBody(val mimeType: String, val bytes: ByteArray)

/**
 * The only code that opens a connection to a Semprec server. It sends JSON, attaches the bearer token when it has
 * one, and turns every status or transport problem into a [FailureKind]; cancellation is rethrown, never mapped.
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
        val response = http.request {
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
        }
        val failure = failureKind(response.status)
        if (failure == null) {
            ApiResponse.Success(response.status.value, response.bodyAsText(), response.headers[HttpHeaders.ETag])
        } else {
            ApiResponse.Failure(failure, response.status.value)
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
        val response = http.request {
            method = HttpMethod.Post
            url("$serverUrl$path")
            headers(token)
            extraHeaders.forEach { (name, value) -> header(name, value) }
            contentType(ContentType.parse(body.mimeType))
            timeout { requestTimeoutMillis = UPLOAD_TIMEOUT_MILLIS }
            setBody(body.bytes)
        }
        val failure = failureKind(response.status)
        if (failure == null) ApiResponse.Success(response.status.value, response.bodyAsText())
        else ApiResponse.Failure(failure, response.status.value)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
    }

    /** Reads the bytes of a `GET`, with the media type the server named. */
    suspend fun download(serverUrl: String, path: String, token: String?): ApiBytesResponse = try {
        val response = http.request {
            method = HttpMethod.Get
            url("$serverUrl$path")
            if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
        }
        val failure = failureKind(response.status)
        if (failure == null) {
            val type = response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim()
            ApiBytesResponse.Success(response.status.value, type ?: DEFAULT_MEDIA_TYPE, response.bodyAsBytes())
        } else {
            ApiBytesResponse.Failure(failure, response.status.value)
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ApiBytesResponse.Failure(FailureKind.UNAVAILABLE, null)
    }

    private fun HttpRequestBuilder.headers(token: String?) {
        header(HttpHeaders.Accept, ContentType.Application.Json.toString())
        if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
    }

    private companion object {
        val configuration: io.ktor.client.HttpClientConfig<*>.() -> Unit = {
            expectSuccess = false
            install(HttpTimeout) {
                requestTimeoutMillis = REQUEST_TIMEOUT_MILLIS
                connectTimeoutMillis = CONNECT_TIMEOUT_MILLIS
            }
        }
    }
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
