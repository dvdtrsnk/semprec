package cz.alldots.app.data

import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.JournalPeriod
import cz.alldots.app.domain.JournalPeriodType
import cz.alldots.app.domain.PageDocument
import cz.alldots.app.domain.PageWrite
import cz.alldots.app.domain.RepositoryResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

private val OFFLINE_DAY = JournalPeriod(JournalPeriodType.DAY, "2026-11-23")

private fun dayBody(item: String?, markdown: String?): String {
    val itemJson = item?.let { """{"id":"$it","properties":{}}""" } ?: "null"
    val markdownJson = markdown?.let { "\"$it\"" } ?: "null"
    return """{"type":"day","period":"2026-11-23","range":{"from":"2026-11-23","to":"2026-11-23"},""" +
        """"today":"2026-11-23","item":$itemJson,"markdown":$markdownJson,"inbox":[],"events":[],"birthdays":[]}"""
}

/** The Journal with the offline set kept on the device: a period shows the page and the text the device holds. */
@OptIn(ExperimentalCoroutinesApi::class)
class HttpJournalRepositoryOfflineTest {
    private val directory = newTestDirectory()
    private val requests = mutableListOf<String>()
    private var reachable = true
    private var day = dayBody(null, null)

    private fun TestScope.repository(): HttpJournalRepository {
        val engine = MockEngine { request ->
            if (!reachable) error("no network")
            requests += "${request.method.value} ${request.url.encodedPath}"
            when {
                request.url.encodedPath.endsWith("/page.md") ->
                    respond("Hello", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"v1\""))
                else -> respond(day, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val layer = OfflineLayer(OfflineStore(directory, StandardTestDispatcher(testScheduler)), backgroundScope)
        return HttpJournalRepository(AuthenticatedApi(ApiClient(engine), storage, offline = layer) {})
    }

    private fun <T> RepositoryResult<T>.content(): T = assertIs<RepositoryResult.Content<T>>(this).value

    @Test fun `a day the device made a page for shows that page with the text written on it`() = runTest {
        val repository = repository()
        repository.period(OFFLINE_DAY)
        reachable = false
        val itemId = repository.ensurePage(OFFLINE_DAY).content()
        assertEquals(PageWrite.Kept, repository.replacePage(itemId, "Written offline", "", "").content())

        val shown = repository.period(OFFLINE_DAY).content()
        assertEquals(itemId, shown.itemId)
        assertEquals("Written offline", shown.markdown)
    }

    @Test fun `a day shows the text written on the device that the server does not hold yet`() = runTest {
        day = dayBody("item-day", "Hello")
        val repository = repository()
        assertEquals("Hello", repository.period(OFFLINE_DAY).content().markdown)
        assertEquals(PageDocument("Hello", "\"v1\""), repository.page("item-day").content())
        assertEquals(PageDocument("Hello", "\"v1\""), repository.page("item-day").content())
        assertEquals(1, requests.count { it == "GET /api/items/item-day/page.md" })
        reachable = false
        assertEquals(PageWrite.Kept, repository.replacePage("item-day", "Hello again", "\"v1\"", "Hello").content())

        val shown = repository.period(OFFLINE_DAY).content()
        assertEquals("item-day", shown.itemId)
        assertEquals("Hello again", shown.markdown)
    }

    @Test fun `a day without a page and nothing written on the device shows no page`() = runTest {
        val repository = repository()
        val shown = repository.period(OFFLINE_DAY).content()
        assertNull(shown.itemId)
        assertNull(shown.markdown)
        assertEquals(listOf("GET /api/journal/periods/day/2026-11-23"), requests)
    }
}
