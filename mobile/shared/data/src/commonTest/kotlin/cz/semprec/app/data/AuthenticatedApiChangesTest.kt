package cz.semprec.app.data

import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.ItemChanges
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class AuthenticatedApiChangesTest {
    private val changes = ItemChanges()

    private fun api(status: HttpStatusCode = HttpStatusCode.OK): AuthenticatedApi {
        val engine = MockEngine { respond("{}", status) }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        return AuthenticatedApi(ApiClient(engine), storage, changes) {}
    }

    /** Counts the announcements made while [block] runs. */
    private suspend fun TestScope.announcements(block: suspend () -> Unit): Int {
        var count = 0
        val collector = launch(UnconfinedTestDispatcher(testScheduler), start = CoroutineStart.UNDISPATCHED) {
            changes.events.collect { count += 1 }
        }
        block()
        collector.cancel()
        return count
    }

    @Test fun `a successful write is announced`() = runTest {
        val api = api()
        assertEquals(1, announcements { api.send(HttpMethod.Post, "/api/databases/d1/items", body = "{}") })
        assertEquals(1, announcements { api.send(HttpMethod.Patch, "/api/items/i1", body = "{}") })
        assertEquals(1, announcements { api.send(HttpMethod.Put, "/api/items/i1/relations/area", body = "{}") })
        assertEquals(1, announcements { api.send(HttpMethod.Delete, "/api/items/i1") })
    }

    @Test fun `a read is not announced`() = runTest {
        val api = api()
        assertEquals(0, announcements { api.send(HttpMethod.Get, "/api/items/i1") })
        assertEquals(0, announcements { api.send(HttpMethod.Post, "/api/databases/d1/query", body = "{}") })
        assertEquals(0, announcements { api.send(HttpMethod.Post, "/api/items/count", body = "{}") })
        assertEquals(0, announcements { api.send(HttpMethod.Get, "/api/search", listOf("q" to "x")) })
        assertEquals(0, announcements { api.send(HttpMethod.Post, "/api/search/recent", body = "{}") })
        val preview = "/api/mail/projects/p1/signals/preview"
        assertEquals(0, announcements { api.send(HttpMethod.Post, preview, body = "{}") })
    }

    @Test fun `saving and applying mail signals are announced`() = runTest {
        val api = api()
        assertEquals(1, announcements { api.send(HttpMethod.Put, "/api/mail/projects/p1/signals", body = "{}") })
        assertEquals(1, announcements { api.send(HttpMethod.Post, "/api/mail/projects/p1/signals/apply", body = "{}") })
    }

    @Test fun `saving the text of a page is not announced`() = runTest {
        val api = api()
        assertEquals(0, announcements { api.send(HttpMethod.Put, "/api/journal/periods/day/2026-11-16/doc") })
        assertEquals(0, announcements { api.send(HttpMethod.Put, "/api/items/i1/page.md", body = "# x") })
    }

    @Test fun `a failed write is not announced`() = runTest {
        val api = api(HttpStatusCode.Conflict)
        assertEquals(0, announcements { api.send(HttpMethod.Patch, "/api/items/i1", body = "{}") })
    }

    @Test fun `an upload is announced unless it only stages a blob`() = runTest {
        val api = api()
        val body = RawBody("audio/m4a", byteArrayOf(1))
        assertEquals(0, announcements { api.upload("/api/blobs", body, emptyList()) })
        assertEquals(1, announcements { api.upload("/api/recordings", body, emptyList()) })
    }

    @Test fun `the query string does not change what a path means`() {
        assertEquals(false, AuthenticatedApi.announces(HttpMethod.Post, "/api/databases/d1/query?limit=5"))
        assertEquals(true, AuthenticatedApi.announces(HttpMethod.Post, "/api/inbox/items?source=typed"))
    }
}
