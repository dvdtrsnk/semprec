package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TaskScope
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.minutes
import kotlin.time.TestTimeSource

private const val WARM_TODAY = "2026-11-23"
private const val DIARY_ITEM = "day-20"
private val WARM_SESSION = StoredSession("https://s.example", "tok")
private val WARM_DATABASES = listOf(
    "tasks", "areas", "projects", "people", "calendars", "invitations", "events", "sleepSettings", "sleepPlans",
)
private val WARM_SCHEMA = """{"tenant":{"timezone":"Europe/Prague","today":"$WARM_TODAY"},"databases":[""" +
    WARM_DATABASES.joinToString(",") { """{"databaseId":"db-$it","key":"$it"}""" } + "]}"
private val WARM_DATABASE_LIST = """{"databases":[""" +
    WARM_DATABASES.joinToString(",") { """{"id":"db-$it","key":"$it"}""" } + "]}"
private const val WARM_PROJECT = """{"items":[{"id":"p1","databaseId":"db-projects",""" +
    """"properties":{"name":"Garden"},"relations":{}}]}"""
private const val WARM_TIMELINE = """{"timezone":"Europe/Prague","today":"$WARM_TODAY",""" +
    """"now":{"date":"$WARM_TODAY","time":"08:00"},"from":"2026-09-21","to":"2027-02-15","items":[]}"""

/** A day of the diary: the 20th has a page, the other days none. */
private fun diaryDay(day: String): String {
    val page = if (day == "2026-11-20") {
        """{"id":"$DIARY_ITEM","properties":{}},"markdown":"Friday""""
    } else {
        """null,"markdown":null"""
    }
    return """{"type":"day","period":"$day","range":{"from":"$day","to":"$day"},"today":"$WARM_TODAY",""" +
        """"item":$page,"inbox":[],"events":[],"birthdays":[]}"""
}

/**
 * A server answering every read of the warm-up; each request is recorded as `METHOD path?query body`. [reachable]
 * false makes every request go unanswered, and [failing] answers `500` on those paths. It answers on [dispatcher],
 * so a test's scheduler runs the requests a background warm-up sends.
 */
private class WarmServer(dispatcher: CoroutineDispatcher) {
    val requests = mutableListOf<String>()
    var reachable = true
    val failing = mutableSetOf<String>()

    val engine = MockEngine(
        MockEngineConfig().apply {
            this.dispatcher = dispatcher
            addHandler { request -> answer(request) }
        },
    )

    private suspend fun MockRequestHandleScope.answer(request: HttpRequestData): HttpResponseData {
        check(reachable) { "no network" }
        val path = request.url.encodedPath
        val query = request.url.encodedQuery.takeIf { it.isNotEmpty() }?.let { "?$it" }.orEmpty()
        val body = request.body.toByteArray().decodeToString().takeIf { it.isNotEmpty() }?.let { " $it" }.orEmpty()
        requests += "${request.method.value} $path$query$body"
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        return when {
            path in failing -> respond("{}", HttpStatusCode.InternalServerError, json)
            path == "/api/items/$DIARY_ITEM/page.md" ->
                respond("Friday", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"v1\""))
            path.startsWith("/api/journal/periods/day/") ->
                respond(diaryDay(path.substringAfterLast('/')), HttpStatusCode.OK, json)
            else -> respond(answerOf(path), HttpStatusCode.OK, json)
        }
    }

    private fun answerOf(path: String): String = when (path) {
        "/api/schema" -> WARM_SCHEMA
        "/api/databases" -> WARM_DATABASE_LIST
        "/api/databases/db-projects/query" -> WARM_PROJECT
        "/api/calendar/timeline" -> WARM_TIMELINE
        "/api/sleep/nights" -> """{"nights":[]}"""
        "/api/inbox/cards" -> """{"cards":[],"total":0}"""
        "/api/inbox-types" -> """{"types":[]}"""
        else -> if (path.endsWith("/query") || path == "/api/calendar/agenda") """{"items":[]}""" else "{}"
    }

    fun count(prefix: String) = requests.count { it.startsWith(prefix) }
}

/** The session of [inner]; after [arm], its next read throws, as a read that fails unexpectedly inside a repository. */
private class ThrowingStorage(private val inner: SessionStorage) : SessionStorage by inner {
    private var armed = false

    fun arm() {
        armed = true
    }

    override fun load(): StoredSession? {
        if (!armed) return inner.load()
        armed = false
        throw IllegalStateException("the session cannot be read")
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineWarmupTest {
    private val directory = newTestDirectory()
    private lateinit var server: WarmServer
    private val time = TestTimeSource()
    private val storage = InMemorySessionStorage().apply { save(WARM_SESSION) }

    /** The layer of a test, and the server it reaches, which answers on the test's scheduler. */
    private fun TestScope.layer(): OfflineLayer = OfflineLayer(
        OfflineStore(directory, StandardTestDispatcher(testScheduler)),
        backgroundScope,
        time,
        QueueClock(now = { "2026-11-23T10:00:00Z" }, random = { 0.0 }, today = { WARM_TODAY }),
    ).also { server = WarmServer(StandardTestDispatcher(testScheduler)) }

    private fun api(layer: OfflineLayer) = AuthenticatedApi(ApiClient(server.engine), storage, offline = layer) {}

    private fun <T> RepositoryResult<T>.content(): T = assertIs<RepositoryResult.Content<T>>(this).value

    @Test fun `a warm-up sends each read of the screens once with their requests`() = runTest {
        val api = api(layer())
        OfflineWarmup(api) { WARM_TODAY }.run { true }

        val expected = listOf(
            "GET /api/schema",
            "GET /api/databases?limit=200",
            "POST /api/databases/db-areas/query {\"limit\":200}",
            "POST /api/databases/db-projects/query {\"include\":{\"relations\":{\"area\":[]}},\"limit\":200}",
            "POST /api/databases/db-people/query {\"limit\":200}",
            "POST /api/databases/db-calendars/query {\"include\":{\"relations\":{\"account\":[\"addresses\"]}}}",
            "POST /api/databases/db-invitations/query {}",
            "GET /api/calendar/timeline?from=2026-09-21&to=2026-11-16",
            "POST /api/databases/db-calendars/query {}",
            "GET /api/badge-counts",
            "GET /api/calendar/timeline?from=2026-10-19&to=2026-12-14",
            "GET /api/calendar/timeline?from=2026-11-23&to=2027-01-18",
            "GET /api/calendar/timeline?from=2026-12-21&to=2027-02-15",
            "GET /api/calendar/agenda?from=2026-11-23&direction=forward&limit=50",
        ) + (16..20).map { "GET /api/journal/periods/day/2026-11-$it" } + "GET /api/items/$DIARY_ITEM/page.md" +
            (21..30).map { "GET /api/journal/periods/day/2026-11-$it" } + listOf(
                "GET /api/overview",
                "POST /api/databases/db-projects/query {\"filter\":{\"type\":\"equals\",\"property\":\"pinned\"," +
                    "\"value\":true},\"include\":{\"relations\":{\"area\":[]}},\"limit\":200}",
                "POST /api/databases/db-sleepSettings/query {}",
                "POST /api/databases/db-sleepPlans/query {}",
                "GET /api/sleep/nights?from=2026-11-23&to=2026-11-23",
                "GET /api/inbox/cards",
                "GET /api/inbox-types",
            )
        val tasks = server.requests.filter { it.startsWith("POST /api/databases/db-tasks/query") }
        assertEquals(TaskScope.entries.size, tasks.distinct().size)
        assertEquals(expected, server.requests - tasks.toSet())
        assertEquals(0, server.count("GET /api/inbox/cards/count"))
    }

    @Test fun `after a warm-up the screens open without a connection`() = runTest {
        val layer = layer()
        val api = api(layer)
        OfflineWarmup(api) { WARM_TODAY }.run { true }
        layer.frameArrived()
        server.reachable = false

        val december = HttpCalendarRepository(api, CalendarChanges())
            .window(CalendarDay(2026, 11, 23), CalendarDay(2027, 1, 18)).content()
        assertEquals(WARM_TODAY, december.timeline.today.toString())
        val journal = HttpJournalRepository(api)
        val friday = journal.period(JournalPeriod(JournalPeriodType.DAY, "2026-11-20")).content()
        assertEquals(DIARY_ITEM, friday.itemId)
        assertEquals(PageDocument("Friday", "\"v1\""), journal.page(DIARY_ITEM).content())
        val work = WorkData(api)
        TaskScope.entries.forEach { scope -> work.tasks.tasks(scope).content() }
        HttpOverviewRepository(api).load().content()
        assertEquals(listOf("Garden"), work.catalog.projects().content().map { it.title })
    }

    @Test fun `a read that fails is left as it is and the next ones go on`() = runTest {
        val api = api(layer())
        server.failing += "/api/overview"
        OfflineWarmup(api) { WARM_TODAY }.run { true }
        assertEquals(1, server.count("GET /api/overview"))
        assertEquals(1, server.count("GET /api/inbox-types"))
    }

    @Test fun `a read that throws is left as it is and the next ones go on`() = runTest {
        val layer = layer()
        val throwing = ThrowingStorage(storage)
        val api = AuthenticatedApi(ApiClient(server.engine), throwing, offline = layer) {}
        runCurrent()
        throwing.arm()
        OfflineWarmup(api) { WARM_TODAY }.run { true }
        assertEquals("GET /api/databases?limit=200", server.requests.first())
        assertEquals(1, server.count("GET /api/inbox-types"))
    }

    @Test fun `the reads stop once the process is offline`() = runTest {
        val api = api(layer())
        var checks = 0
        OfflineWarmup(api) { WARM_TODAY }.run { ++checks <= 2 }
        assertEquals(listOf("GET /api/schema", "GET /api/databases?limit=200"), server.requests)
    }

    @Test fun `a day that cannot be read sends nothing`() = runTest {
        OfflineWarmup(api(layer())) { "nonsense" }.run { true }
        assertTrue(server.requests.isEmpty())
    }

    @Test fun `a window that starts with a session warms up and again only after 30 minutes`() = runTest {
        val layer = layer()
        layer.warmUpWith(OfflineWarmup(api(layer)) { WARM_TODAY })
        runCurrent()
        assertEquals(1, server.count("GET /api/overview"))

        layer.connected()
        runCurrent()
        time += 29.minutes
        layer.connected()
        runCurrent()
        assertEquals(1, server.count("GET /api/overview"))

        time += 1.minutes
        layer.connected()
        runCurrent()
        assertEquals(2, server.count("GET /api/overview"))
    }

    @Test fun `a window that starts offline or signed out warms up only once a later trigger finds it online`() =
        runTest {
            val layer = layer()
            storage.save(null)
            layer.warmUpWith(OfflineWarmup(api(layer)) { WARM_TODAY })
            runCurrent()
            assertTrue(server.requests.isEmpty())

            storage.save(WARM_SESSION)
            layer.observed(ApiResponse.Failure(FailureKind.UNAVAILABLE, null))
            layer.connected()
            layer.observed(ApiResponse.Failure(FailureKind.UNAVAILABLE, null))
            runCurrent()
            assertEquals(0, server.count("GET /api/overview"))

            layer.observed(ApiResponse.Success(200, "{}"))
            runCurrent()
            assertEquals(1, server.count("GET /api/overview"))
        }

    @Test fun `the warm-up reads after the queue replayed what was written offline`() = runTest {
        val layer = layer()
        val api = api(layer)
        server.reachable = false
        api.send(HttpMethod.Delete, "/api/items/t1")
        server.reachable = true
        layer.warmUpWith(OfflineWarmup(api) { WARM_TODAY })
        runCurrent()
        val delete = server.requests.indexOf("DELETE /api/items/t1")
        assertTrue(delete >= 0)
        assertTrue(delete < server.requests.indexOf("GET /api/schema"))
    }
}
