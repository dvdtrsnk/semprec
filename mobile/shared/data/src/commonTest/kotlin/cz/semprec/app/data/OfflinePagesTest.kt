package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.TestTimeSource

private val PAGE_SESSION = StoredSession("https://s.example", "tok")
private val NO_PAGE_ANSWER = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
private const val PLAN = "# Plan\n\nFirst idea"
private const val DAY_PATH = "/api/journal/periods/day/2026-11-23"

/**
 * A server of note pages: each page has Markdown and a version; a `PUT` against another version answers `409`.
 * [down] makes every request go unanswered, [scripted] answers the request of that number (1 for the first) instead,
 * [gone] answers `404` for those items, and [refusing] answers that failure to every `PUT`. An ensured diary page is
 * the item `server-day`.
 */
private class PageServer : QueueSender {
    val pages = mutableMapOf<String, String>()
    private val versions = mutableMapOf<String, Int>()
    val sent = mutableListOf<String>()
    val scripted = mutableMapOf<Int, ApiResponse>()
    val gone = mutableSetOf<String>()
    var down = false
    var refusing: ApiResponse.Failure? = null
    var alwaysStale = false

    fun put(itemId: String, markdown: String) {
        pages[itemId] = markdown
        versions[itemId] = (versions[itemId] ?: 0) + 1
    }

    fun etag(itemId: String) = "\"v${versions[itemId] ?: 0}\""

    override fun account(): String = accountKey(PAGE_SESSION)

    override fun session(): StoredSession = PAGE_SESSION

    override suspend fun upload(path: String, body: RawBody): ApiResponse = error("No note page uploads")

    override suspend fun send(request: ApiRequest): ApiResponse {
        val itemId = request.path.removePrefix("/api/items/").removeSuffix("/page.md")
        sent += "${request.method.value} $itemId"
        val script = scripted[sent.size]
        val refused = refusing
        return when {
            down -> NO_PAGE_ANSWER
            script != null -> script
            request.path.endsWith("/doc") -> ApiResponse.Success(200, """{"itemId":"server-day"}""")
            itemId in gone -> ApiResponse.Failure(FailureKind.NOT_FOUND, 404)
            request.method == HttpMethod.Get -> ApiResponse.Success(200, pages[itemId].orEmpty(), etag(itemId))
            refused != null -> refused
            alwaysStale || request.extraHeaders.single { it.first == "If-Match" }.second != etag(itemId) ->
                ApiResponse.Failure(FailureKind.REJECTED, 409)
            else -> {
                put(itemId, request.body.orEmpty())
                ApiResponse.Success(200, "{}", etag(itemId))
            }
        }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class OfflinePagesTest {
    private val directory = newTestDirectory()
    private val server = PageServer().apply { put("p1", PLAN) }
    private var lastId = 0

    private fun TestScope.layer() = OfflineLayer(
        OfflineStore(directory, StandardTestDispatcher(testScheduler)),
        backgroundScope,
        TestTimeSource(),
        QueueClock(now = { "2026-11-23T10:00:00Z" }, random = { 0.0 }, today = { "2026-11-23" }),
        newId = { "made-${++lastId}" },
    ).also { it.writes.attach(server) }

    private fun <T> RepositoryResult<T>.content(): T = assertIs<RepositoryResult.Content<T>>(this).value

    private fun RepositoryResult<*>.failure(): FailureKind = assertIs<RepositoryResult.Failure>(this).kind

    private fun TestScope.told(layer: OfflineLayer): List<String> {
        val told = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler), start = CoroutineStart.UNDISPATCHED) {
            layer.pages.changed.collect { told += it }
        }
        return told
    }

    @Test fun `a page read once is read again from the device while nothing changed`() = runTest {
        val layer = layer()
        assertEquals(PageDocument(PLAN, "\"v1\""), layer.pages.read("p1").content())
        assertEquals(PageDocument(PLAN, "\"v1\""), layer.pages.read("p1").content())
        assertEquals(listOf("GET p1"), server.sent)
    }

    @Test fun `after a change signal the page is read again and becomes the base`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.put("p1", "# Plan\n\nChanged elsewhere")
        layer.frameArrived()
        assertEquals("# Plan\n\nChanged elsewhere", layer.pages.read("p1").content().markdown)
        assertEquals(listOf("GET p1", "GET p1"), server.sent)
    }

    @Test fun `without a connection a kept page is read from the device`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        layer.frameArrived()
        server.down = true
        layer.observed(NO_PAGE_ANSWER)
        assertEquals(PLAN, layer.pages.read("p1").content().markdown)
        assertEquals(listOf("GET p1"), server.sent)
    }

    @Test fun `a kept page the server cannot answer for is read from the device`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        layer.frameArrived()
        server.scripted[2] = ApiResponse.Failure(FailureKind.UNAVAILABLE, 503)
        assertEquals(PageDocument(PLAN, "\"v1\""), layer.pages.read("p1").content())
        assertEquals(listOf("GET p1", "GET p1"), server.sent)
    }

    @Test fun `without a connection a page never read fails as unavailable`() = runTest {
        val layer = layer()
        server.down = true
        assertEquals(FailureKind.UNAVAILABLE, layer.pages.read("p1").failure())
    }

    @Test fun `a page the server no longer has is not found and nothing is kept of it`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.gone += "p1"
        layer.frameArrived()
        assertEquals(FailureKind.NOT_FOUND, layer.pages.read("p1").failure())
        server.down = true
        layer.observed(NO_PAGE_ANSWER)
        assertEquals(FailureKind.UNAVAILABLE, layer.pages.read("p1").failure())
    }

    @Test fun `a page answered without a version is invalid data`() = runTest {
        val layer = layer()
        server.scripted[1] = ApiResponse.Success(200, PLAN)
        assertEquals(FailureKind.INVALID_DATA, layer.pages.read("p1").failure())
    }

    @Test fun `a read the server refuses fails as it refused`() = runTest {
        val layer = layer()
        server.scripted[1] = ApiResponse.Failure(FailureKind.REJECTED, 403)
        assertEquals(FailureKind.REJECTED, layer.pages.read("p1").failure())
    }

    @Test fun `without a session nothing is read or written`() = runTest {
        val layer = OfflineLayer(OfflineStore(directory, StandardTestDispatcher(testScheduler)), backgroundScope)
        assertEquals(FailureKind.UNAUTHORIZED, layer.pages.read("p1").failure())
        assertEquals(FailureKind.UNAUTHORIZED, layer.pages.write("p1", "x", "\"v1\"", PLAN).failure())
    }

    @Test fun `a write against the version read is saved and becomes the base`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        val written = layer.pages.write("p1", "# Plan\n\nBetter idea", "\"v1\"", PLAN).content()
        assertEquals(PageWrite.Saved("\"v2\""), written)
        assertEquals("# Plan\n\nBetter idea", server.pages["p1"])
        assertNull(layer.pages.localText("p1"))
        assertEquals(PageDocument("# Plan\n\nBetter idea", "\"v2\""), layer.pages.read("p1").content())
    }

    @Test fun `a saved page stays fresh while every other kept answer turns stale`() = runTest {
        val layer = layer()
        val period = ApiRequest(HttpMethod.Get, DAY_PATH)
        var periodReads = 0
        val transmit: suspend (ApiRequest) -> ApiResponse = {
            periodReads += 1
            ApiResponse.Success(200, "{}")
        }
        layer.read(PAGE_SESSION, period, transmit)
        layer.read(PAGE_SESSION, period, transmit)
        assertEquals(1, periodReads)
        layer.pages.read("p1")
        layer.pages.write("p1", "# Plan\n\nSaved", "\"v1\"", PLAN)
        layer.pages.read("p1")
        layer.read(PAGE_SESSION, period, transmit)
        assertEquals(listOf("GET p1", "PUT p1"), server.sent)
        assertEquals(2, periodReads)
    }

    @Test fun `a write saved without a version keeps the version it was written against`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.scripted[2] = ApiResponse.Success(200, "{}")
        assertEquals(PageWrite.Saved("\"v1\""), layer.pages.write("p1", "# Plan", "\"v1\"", PLAN).content())
    }

    @Test fun `a write of a page changed elsewhere is merged three ways and written again`() = runTest {
        val layer = layer()
        val told = told(layer)
        layer.pages.read("p1")
        server.put("p1", "$PLAN\n\nFrom the Mac")
        val written = assertIs<PageWrite.Merged>(
            layer.pages.write("p1", "# Plan for today\n\nFirst idea", "\"v1\"", PLAN).content(),
        )
        assertEquals("# Plan for today\n\nFirst idea\n\nFrom the Mac", written.markdown)
        assertEquals(written.markdown, server.pages["p1"])
        assertEquals(server.etag("p1"), written.etag)
        assertEquals(listOf("GET p1", "PUT p1", "GET p1", "PUT p1"), server.sent)
        assertEquals(listOf("p1"), told)
    }

    @Test fun `a write merged and still stale three times answers a conflict`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.alwaysStale = true
        assertEquals(PageWrite.Conflict, layer.pages.write("p1", "# Mine", "\"v1\"", PLAN).content())
        assertEquals(1 + 4 + 3, server.sent.size)
    }

    @Test fun `a write edited from a text the device no longer holds is merged with the device's text first`() =
        runTest {
            val layer = layer()
            layer.pages.read("p1")
            val first = layer.pages.write("p1", "$PLAN\n\nFrom window one", "\"v1\"", PLAN).content()
            assertEquals(PageWrite.Saved("\"v2\""), first)
            val second = layer.pages.write("p1", "# Plan for today\n\nFirst idea", "\"v1\"", PLAN).content()
            val merged = "# Plan for today\n\nFirst idea\n\nFrom window one"
            assertEquals(PageWrite.Merged("\"v3\"", merged), second)
            assertEquals(merged, server.pages["p1"])
            assertEquals(listOf("GET p1", "PUT p1", "PUT p1"), server.sent)
        }

    @Test fun `without a connection a write merged with another window's text answers the merge`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.down = true
        assertEquals(PageWrite.Kept, layer.pages.write("p1", "$PLAN\n\nFrom window one", "\"v1\"", PLAN).content())
        val second = layer.pages.write("p1", "# Plan for today\n\nFirst idea", "\"v1\"", PLAN).content()
        val merged = "# Plan for today\n\nFirst idea\n\nFrom window one"
        assertEquals(PageWrite.Merged("\"v1\"", merged), second)
        assertEquals(merged, layer.pages.localText("p1"))
    }

    @Test fun `a write merged before the connection dropped keeps the merge and answers it`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.put("p1", "$PLAN\n\nFrom the Mac")
        server.scripted[4] = NO_PAGE_ANSWER
        val written = layer.pages.write("p1", "# Plan for today\n\nFirst idea", "\"v1\"", PLAN).content()
        val merged = "# Plan for today\n\nFirst idea\n\nFrom the Mac"
        assertEquals(PageWrite.Merged("\"v2\"", merged), written)
        assertEquals(merged, layer.pages.localText("p1"))
        assertEquals("$PLAN\n\nFrom the Mac", server.pages["p1"])
    }

    @Test fun `a write whose merge read gets no answer is kept as written`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.put("p1", "$PLAN\n\nFrom the Mac")
        server.scripted[3] = NO_PAGE_ANSWER
        assertEquals(PageWrite.Kept, layer.pages.write("p1", "# Mine", "\"v1\"", PLAN).content())
        assertEquals("# Mine", layer.pages.localText("p1"))
    }

    @Test fun `a write whose merge read finds the item gone forgets the page`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.put("p1", "$PLAN\n\nFrom the Mac")
        server.scripted[3] = ApiResponse.Failure(FailureKind.NOT_FOUND, 404)
        assertEquals(FailureKind.NOT_FOUND, layer.pages.write("p1", "# Mine", "\"v1\"", PLAN).failure())
        assertNull(layer.pages.localText("p1"))
    }

    @Test fun `a write whose merge read is refused fails as it was refused and keeps the text`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.put("p1", "$PLAN\n\nFrom the Mac")
        server.scripted[3] = ApiResponse.Failure(FailureKind.REJECTED, 403)
        assertEquals(FailureKind.REJECTED, layer.pages.write("p1", "# Mine", "\"v1\"", PLAN).failure())
        assertEquals("# Mine", layer.pages.localText("p1"))
    }

    @Test fun `a write without a connection is kept on the device`() = runTest {
        val layer = layer()
        val told = told(layer)
        layer.pages.read("p1")
        server.down = true
        assertEquals(PageWrite.Kept, layer.pages.write("p1", "# Offline", "\"v1\"", PLAN).content())
        assertEquals("# Offline", layer.pages.localText("p1"))
        layer.observed(NO_PAGE_ANSWER)
        assertEquals(PageDocument("# Offline", "\"v1\""), layer.pages.read("p1").content())
        assertTrue(told.isEmpty())
    }

    @Test fun `a write answered with a server error is kept on the device`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.refusing = ApiResponse.Failure(FailureKind.UNAVAILABLE, 503)
        assertEquals(PageWrite.Kept, layer.pages.write("p1", "# Later", "\"v1\"", PLAN).content())
        assertEquals("# Later", layer.pages.localText("p1"))
    }

    @Test fun `a refused write fails as the server refused it and its text stays on the device`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.refusing = ApiResponse.Failure(FailureKind.REJECTED, 400)
        assertEquals(FailureKind.REJECTED, layer.pages.write("p1", "# x", "\"v1\"", PLAN).failure())
        assertEquals("# x", layer.pages.localText("p1"))
        layer.frameArrived()
        assertEquals("# x", layer.pages.read("p1").content().markdown)
    }

    @Test fun `a write of an item the server no longer has forgets the page with its text`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.gone += "p1"
        assertEquals(FailureKind.NOT_FOUND, layer.pages.write("p1", "# Lost", "\"v1\"", PLAN).failure())
        assertNull(layer.pages.localText("p1"))
    }

    @Test fun `a read while a local text waits writes it first`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.down = true
        layer.pages.write("p1", "# Plan\n\nWritten offline", "\"v1\"", PLAN)
        server.down = false
        layer.wrote()
        assertEquals("# Plan\n\nWritten offline", layer.pages.read("p1").content().markdown)
        assertEquals("# Plan\n\nWritten offline", server.pages["p1"])
        assertNull(layer.pages.localText("p1"))
    }

    @Test fun `a read whose waiting text finds the item gone is not found`() = runTest {
        val layer = layer()
        layer.pages.read("p1")
        server.down = true
        layer.pages.write("p1", "# Plan\n\nWritten offline", "\"v1\"", PLAN)
        server.down = false
        server.gone += "p1"
        layer.wrote()
        assertEquals(FailureKind.NOT_FOUND, layer.pages.read("p1").failure())
        assertNull(layer.pages.localText("p1"))
    }

    @Test fun `a kept page survives a restart`() = runTest {
        val first = layer()
        first.pages.read("p1")
        server.down = true
        first.pages.write("p1", "# Kept", "\"v1\"", PLAN)
        assertEquals("# Kept", layer().pages.localText("p1"))
    }

    @Test fun `waiting pages are written when the connection is back and merges are told`() = runTest {
        val layer = layer()
        val told = told(layer)
        layer.pages.read("p1")
        server.down = true
        layer.pages.write("p1", "$PLAN\n\nWritten offline", "\"v1\"", PLAN)
        server.down = false
        server.put("p1", "# Plan for today\n\nFirst idea")
        layer.pages.writeWaiting()
        assertEquals("# Plan for today\n\nFirst idea\n\nWritten offline", server.pages["p1"])
        assertNull(layer.pages.localText("p1"))
        assertEquals(listOf("p1"), told)
    }

    @Test fun `a window still showing a page written in the background has its next change merged with it`() =
        runTest {
            val layer = layer()
            layer.pages.read("p1")
            server.down = true
            val offline = "$PLAN\n\nWritten offline"
            layer.pages.write("p1", offline, "\"v1\"", PLAN)
            server.down = false
            server.put("p1", "# Plan for today\n\nFirst idea")
            layer.pages.writeWaiting()
            val written = layer.pages.write("p1", "$offline, then more", "\"v1\"", offline).content()
            val merged = "# Plan for today\n\nFirst idea\n\nWritten offline, then more"
            assertEquals(PageWrite.Merged(server.etag("p1"), merged), written)
            assertEquals(merged, server.pages["p1"])
        }

    @Test fun `a page without a base reads the server first and merges with an empty base`() = runTest {
        val layer = layer()
        server.put("p2", "Written on the Mac")
        val written = assertIs<PageWrite.Merged>(layer.pages.write("p2", "Written on the phone", "", "").content())
        assertEquals("Written on the phone\n\nWritten on the Mac", written.markdown)
        assertEquals(listOf("GET p2", "PUT p2"), server.sent)
    }

    @Test fun `a page without a base over an empty page is saved as written`() = runTest {
        val layer = layer()
        assertEquals(PageWrite.Saved("\"v1\""), layer.pages.write("p3", "Fresh", "", "").content())
        assertEquals("Fresh", server.pages["p3"])
    }

    @Test fun `a page read elsewhere is written against its version and merged against the text it was read with`() =
        runTest {
            val layer = layer()
            server.put("p1", "$PLAN\n\nFrom the Mac")
            val written = layer.pages.write("p1", "# Plan for today\n\nFirst idea", "\"v1\"", PLAN).content()
            assertEquals(PageWrite.Merged("\"v3\"", "# Plan for today\n\nFirst idea\n\nFrom the Mac"), written)
            assertEquals(listOf("PUT p1", "GET p1", "PUT p1"), server.sent)
        }

    @Test fun `a page of an item the device made waits for the server's id and is merged under it`() = runTest {
        val layer = layer()
        val told = told(layer)
        server.down = true
        layer.observed(NO_PAGE_ANSWER)
        val made = layer.write(PAGE_SESSION, QueuedRoute.PERIOD_PAGE, ApiRequest(HttpMethod.Put, "$DAY_PATH/doc")) {
            NO_PAGE_ANSWER
        }
        val itemId = assertIs<ApiResponse.Success>(made).body.substringAfter("\"itemId\":\"").substringBefore('"')
        assertEquals(itemId, layer.pages.periodItemId(DAY_PATH))
        assertEquals(PageDocument("", ""), layer.pages.read(itemId).content())
        assertEquals(PageWrite.Kept, layer.pages.write(itemId, "Diary offline", "", "").content())
        runCurrent()
        layer.pages.writeWaiting()
        layer.wrote()
        assertEquals(PageDocument("Diary offline", ""), layer.pages.read(itemId).content())
        assertTrue(server.sent.none { it == "PUT $itemId" || it == "GET $itemId" })

        server.down = false
        server.put("server-day", "From the Mac")
        layer.connected()
        runCurrent()
        assertEquals("Diary offline\n\nFrom the Mac", server.pages["server-day"])
        assertNull(layer.pages.periodItemId(DAY_PATH))
        assertEquals("Diary offline\n\nFrom the Mac", layer.pages.read(itemId).content().markdown)
        assertEquals(listOf(itemId, "server-day"), told)
    }
}
