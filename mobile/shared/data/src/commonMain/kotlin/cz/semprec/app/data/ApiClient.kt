package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
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
     * for none; [query] values are encoded by Ktor.
     */
    suspend fun send(
        serverUrl: String,
        method: HttpMethod,
        path: String,
        token: String? = null,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
    ): ApiResponse = try {
        val response = http.request {
            this.method = method
            url("$serverUrl$path")
            query.forEach { (name, value) -> url.parameters.append(name, value) }
            headers(token)
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }
        val failure = failureKind(response.status)
        if (failure == null) ApiResponse.Success(response.status.value, response.bodyAsText())
        else ApiResponse.Failure(failure, response.status.value)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
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
