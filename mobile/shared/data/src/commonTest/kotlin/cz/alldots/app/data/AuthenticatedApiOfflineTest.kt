package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class AuthenticatedApiOfflineTest {
    private val directory = newTestDirectory()
    private val requests = mutableListOf<String>()
    private var reachable = true

    private fun TestScope.api(offline: OfflineLayer? = layer()): AuthenticatedApi {
        val engine = MockEngine { request ->
            if (!reachable) error("no network")
            requests += "${request.method.value} ${request.url.encodedPath}"
            respond("""{"n":${requests.size}}""", HttpStatusCode.OK, headersOf("ETag", "\"v${requests.size}\""))
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        return AuthenticatedApi(ApiClient(engine), storage, offline = offline) {}
    }

    private fun TestScope.layer() =
        OfflineLayer(OfflineStore(directory, StandardTestDispatcher(testScheduler)), backgroundScope)

    private fun count(route: String) = requests.count { it == route }

    @Test fun `a read of the offline set is answered from the device while nothing changed`() = runTest {
        val api = api()
        val first = api.send(HttpMethod.Get, "/api/overview")
        val second = api.send(HttpMethod.Get, "/api/overview")
        assertEquals(first, second)
        assertEquals(1, count("GET /api/overview"))
        assertEquals("\"v1\"", assertIs<ApiResponse.Success>(second).etag)
    }

    @Test fun `every read of the offline set is kept`() = runTest {
        val api = api()
        val reads = listOf(
            HttpMethod.Get to "/api/schema",
            HttpMethod.Get to "/api/databases",
            HttpMethod.Get to "/api/items/i1",
            HttpMethod.Get to "/api/items/i1/related",
            HttpMethod.Get to "/api/items/i1/page",
            HttpMethod.Get to "/api/calendar/timeline",
            HttpMethod.Get to "/api/calendar/agenda",
            HttpMethod.Get to "/api/calendar/reminders",
            HttpMethod.Get to "/api/badge-counts",
            HttpMethod.Get to "/api/journal/periods/day/2026-11-23",
            HttpMethod.Get to "/api/overview",
            HttpMethod.Get to "/api/sleep/nights",
            HttpMethod.Get to "/api/inbox/cards",
            HttpMethod.Get to "/api/inbox/cards/count",
            HttpMethod.Get to "/api/inbox-types",
            HttpMethod.Post to "/api/databases/d1/query",
            HttpMethod.Post to "/api/databases/d1/facets",
        )
        reads.forEach { (method, path) -> api.send(method, path, body = "{}".takeIf { method == HttpMethod.Post }) }
        reads.forEach { (method, path) -> api.send(method, path, body = "{}".takeIf { method == HttpMethod.Post }) }
        assertEquals(reads.size, requests.size)
    }

    @Test fun `a read outside the offline set always goes to the server`() = runTest {
        val api = api()
        listOf("/api/mail/threads", "/api/search", "/api/items/i1/page.md", "/api/auth/session").forEach { path ->
            api.send(HttpMethod.Get, path)
            api.send(HttpMethod.Get, path)
            assertEquals(2, count("GET $path"), path)
        }
        api.send(HttpMethod.Post, "/api/items/count", body = "{}")
        api.send(HttpMethod.Post, "/api/items/count", body = "{}")
        assertEquals(2, count("POST /api/items/count"))
    }

    @Test fun `a successful write makes the kept reads stale`() = runTest {
        val api = api()
        api.send(HttpMethod.Get, "/api/overview")
        api.send(HttpMethod.Patch, "/api/items/i1", body = "{}")
        api.send(HttpMethod.Get, "/api/overview")
        assertEquals(2, count("GET /api/overview"))
    }

    @Test fun `saving the text of a page makes the kept reads stale`() = runTest {
        val api = api()
        api.send(HttpMethod.Get, "/api/journal/periods/day/2026-11-23")
        api.send(HttpMethod.Put, "/api/items/i1/page.md", body = "# x")
        api.send(HttpMethod.Get, "/api/journal/periods/day/2026-11-23")
        assertEquals(2, count("GET /api/journal/periods/day/2026-11-23"))
    }

    @Test fun `the history upload of a mailbox leaves the kept reads fresh`() = runTest {
        val api = api()
        api.send(HttpMethod.Get, "/api/overview")
        api.send(HttpMethod.Post, "/api/mail/mailboxes/m1/history-index", body = "{}")
        api.send(HttpMethod.Get, "/api/overview")
        assertEquals(1, count("GET /api/overview"))
    }

    @Test fun `without a connection a kept read answers and a read never kept fails`() = runTest {
        val api = api()
        val kept = api.send(HttpMethod.Get, "/api/overview")
        api.send(HttpMethod.Patch, "/api/items/i1", body = "{}")
        reachable = false
        assertEquals(kept, api.send(HttpMethod.Get, "/api/overview"))
        assertEquals(ApiResponse.Failure(FailureKind.UNAVAILABLE, null), api.send(HttpMethod.Get, "/api/schema"))
    }

    @Test fun `a request outside the offline set without an answer makes kept reads answer at once`() = runTest {
        val api = api()
        val kept = api.send(HttpMethod.Get, "/api/overview")
        api.send(HttpMethod.Patch, "/api/items/i1", body = "{}")
        reachable = false
        api.send(HttpMethod.Get, "/api/mail/threads")
        reachable = true
        assertEquals(kept, api.send(HttpMethod.Get, "/api/overview"))
        assertEquals(1, count("GET /api/overview"))
    }

    @Test fun `without an offline layer every read goes to the server and nothing is written`() = runTest {
        val api = api(offline = null)
        api.send(HttpMethod.Get, "/api/overview")
        api.send(HttpMethod.Get, "/api/overview")
        assertEquals(2, count("GET /api/overview"))
        assertTrue(listCacheDirectory(directory).isEmpty())
    }
}
