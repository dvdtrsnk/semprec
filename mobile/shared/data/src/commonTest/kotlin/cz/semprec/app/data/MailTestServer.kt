package cz.semprec.app.data

import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf

/** A scripted server for the mail repositories: records every request and answers by [handler]. */
internal class MailTestServer(private val handler: (HttpRequestData) -> Pair<HttpStatusCode, String>?) {
    val requests = mutableListOf<HttpRequestData>()
    val bodies = mutableListOf<String>()

    fun api(): AuthenticatedApi {
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            val answer = handler(request) ?: (HttpStatusCode.NotFound to "{}")
            json(answer.second, answer.first)
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        return AuthenticatedApi(ApiClient(engine), storage, onSessionRejected = {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode): HttpResponseData =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
}

internal fun ok(body: String) = HttpStatusCode.OK to body

internal fun HttpRequestData.query(name: String) = url.parameters[name]
