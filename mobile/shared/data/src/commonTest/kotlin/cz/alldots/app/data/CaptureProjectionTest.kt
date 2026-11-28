package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.InboxAttachment
import cz.alldots.app.domain.InboxAttachmentLocation
import cz.alldots.app.domain.InboxCapture
import cz.alldots.app.domain.InboxCaptureFile
import cz.alldots.app.domain.InboxCaptureSource
import cz.alldots.app.domain.JournalInboxEntry
import cz.alldots.app.domain.JournalPeriod
import cz.alldots.app.domain.JournalPeriodPage
import cz.alldots.app.domain.JournalPeriodType
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SessionUser
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.time.Duration.Companion.minutes
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlin.time.TestTimeSource

private const val PROJECTION_SERVER = "https://s.example"
private val ADA_SESSION = StoredSession(PROJECTION_SERVER, "tok-ada")
private val BOB_SESSION = StoredSession(PROJECTION_SERVER, "tok-bob")
private val ADA = SessionUser("u1", "ada@example.com", "en", "member")
private val BOB = SessionUser("u2", "bob@example.com", "en", "member")
private val TODAY = CalendarDay(2026, 11, 27)
private val TOMORROW = CalendarDay(2026, 11, 28)
private val TODAY_READ = ApiRequest(HttpMethod.Get, "/api/journal/periods/day/2026-11-27")
private val TOMORROW_READ = ApiRequest(HttpMethod.Get, "/api/journal/periods/day/2026-11-28")
private val TYPES_READ = ApiRequest(HttpMethod.Get, "/api/inbox-types")
private const val TYPES_BODY = """{"types":[{"id":"t1","emoji":"🧾","label":"Invoice"}]}"""
private val CREATED = ApiResponse.Success(201, """{"item":{"id":"srv-1"},"attachments":[]}""")

/** The day answer of [day] whose Inbox lists [inbox], each an entry's JSON. */
private fun dayBody(day: String, vararg inbox: String): String =
    """{"type":"day","period":"$day","range":{"from":"$day","to":"$day"},"today":"$day",""" +
        """"item":null,"markdown":null,"inbox":[${inbox.joinToString(",")}],"events":[],"birthdays":[]}"""

private fun dayAnswer(day: String, vararg inbox: String) = ApiResponse.Success(200, dayBody(day, *inbox))

private fun ApiResponse.inbox(): List<JsonObject> =
    Json.parseToJsonElement(assertIs<ApiResponse.Success>(this).body).jsonObject.getValue("inbox").jsonArray
        .map { it.jsonObject }

private fun ApiResponse.inboxIds(): List<String> = inbox().map { it.getValue("id").jsonPrimitive.content }

/** The window's sender: [item] answers `POST /api/inbox/items`; a file is uploaded as blob `b1`. */
private class ProjectionServer : QueueSender {
    var session: StoredSession? = ADA_SESSION
    var item: suspend (ApiRequest) -> ApiResponse = { CompletableDeferred<ApiResponse>().await() }

    override fun account(): String? = session?.let(::accountKey)

    override fun session(): StoredSession? = session

    override suspend fun send(request: ApiRequest): ApiResponse = item(request)

    override suspend fun upload(path: String, body: RawBody): ApiResponse =
        ApiResponse.Success(201, """{"blobId":"b1","byteSize":3,"mimeType":"${body.mimeType}"}""")
}

/** The diary's day answer lists the Inbox captures that wait in the outbox, and a capture makes it read again. */
@OptIn(ExperimentalCoroutinesApi::class, ExperimentalTime::class)
class CaptureProjectionTest {
    private val directory = newTestDirectory()
    private val server = ProjectionServer()
    private var lastId = 0
    private var minute = 0

    private fun TestScope.layer(): OfflineLayer = OfflineLayer(
        OfflineStore(directory, StandardTestDispatcher(testScheduler)),
        backgroundScope,
        TestTimeSource(),
        QueueClock(
            now = { Instant.parse("2026-11-27T10:00:00Z").plus(minute.minutes).toString() },
            random = { 0.0 },
            today = { "2026-11-27" },
        ),
        newId = { "c${++lastId}" },
    )

    /** Keeps [person] for [session], as a sign-in does; the device keeps one account at a time. */
    private suspend fun OfflineLayer.signIn(session: StoredSession = ADA_SESSION, person: SessionUser = ADA) {
        store.people.keep(accountKey(session), person)
    }

    /** Adds a capture made with [session], a minute after the one before. */
    private suspend fun OfflineLayer.add(
        text: String,
        day: CalendarDay = TODAY,
        typeId: String? = null,
        file: InboxCaptureFile? = null,
        session: StoredSession = ADA_SESSION,
    ) {
        minute += 1
        val capture = InboxCapture(text, day, "08:15", typeId, file)
        assertEquals(RepositoryResult.Content(Unit), captures.add(session, capture))
    }

    /** Counts what [OfflineLayer.changes] emits while the test runs. */
    private fun TestScope.emissions(layer: OfflineLayer): () -> Int {
        var count = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler), start = CoroutineStart.UNDISPATCHED) {
            layer.changes.collect { count += 1 }
        }
        return { count }
    }

    @Test fun `offline a capture made through another entry of the process shows at once in its day as waiting`() =
        runTest {
            var reachable = true
            val engine = MockEngine { request ->
                if (!reachable) error("no network")
                val body = if (request.url.encodedPath == TYPES_READ.path) TYPES_BODY else dayBody("2026-11-27")
                respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            }
            val storage = InMemorySessionStorage().apply { save(ADA_SESSION) }
            val layer = layer().also { it.signIn() }
            val window = AuthenticatedApi(ApiClient(engine), storage, offline = layer) {}
            val shortcut = AuthenticatedApi(ApiClient(engine), storage, offline = layer, takesOverSender = false) {}
            val journal = HttpJournalRepository(window)
            val period = JournalPeriod(JournalPeriodType.DAY, "2026-11-27")
            assertIs<RepositoryResult.Content<*>>(journal.period(period))
            assertIs<RepositoryResult.Content<*>>(HttpInboxCaptureRepository(window).types())
            reachable = false
            val changes = emissions(layer)

            val file = InboxCaptureFile("scan.pdf", "application/pdf", byteArrayOf(1), InboxCaptureSource.CAMERA)
            val captured = HttpInboxCaptureRepository(shortcut)
                .capture(InboxCapture("Pay the plumber", TODAY, "08:15", "t1", file))
            assertEquals(RepositoryResult.Content(Unit), captured)
            assertEquals(1, changes(), "adding the capture tells every window")

            val shown = assertIs<RepositoryResult.Content<JournalPeriodPage>>(
                journal.period(period),
            ).value
            assertEquals(
                listOf(
                    JournalInboxEntry(
                        id = "c1",
                        time = "08:15",
                        text = "Pay the plumber",
                        typeEmoji = "🧾",
                        status = WAITING_INBOX_STATUS,
                        processing = null,
                        attachments = listOf(
                            InboxAttachment(
                                id = "c1",
                                name = "scan.pdf",
                                mimeType = "application/pdf",
                                source = "camera",
                                location = InboxAttachmentLocation.WaitingCapture("c1"),
                            ),
                        ),
                    ),
                ),
                shown.inbox,
            )
        }

    @Test fun `online a capture shows as waiting until the send and then only the server's entry shows`() = runTest {
        val layer = layer().also { it.signIn() }
        layer.writes.attach(server)
        val sent = CompletableDeferred<Unit>()
        server.item = {
            sent.await()
            CREATED
        }
        var serverInbox = emptyArray<String>()
        var requests = 0
        suspend fun read() = layer.read(ADA_SESSION, TODAY_READ) {
            requests += 1
            dayAnswer("2026-11-27", *serverInbox)
        }
        read()
        val changes = emissions(layer)

        layer.add("Call the plumber")
        runCurrent()
        assertEquals(1, changes())
        val waiting = read()
        assertEquals(2, requests, "the capture made the kept answer stale, so the day was read from the server")
        assertEquals(listOf("c1"), waiting.inboxIds())
        assertEquals("waiting", waiting.inbox().single().getValue("status").jsonPrimitive.content)

        serverInbox = arrayOf("""{"id":"srv-1","time":"08:15","text":"Call the plumber","status":null}""")
        sent.complete(Unit)
        runCurrent()
        assertEquals(2, changes(), "the send tells every window")
        assertEquals(listOf("srv-1"), read().inboxIds())
        assertEquals(3, requests, "the send made the kept answer stale, so the day was read from the server")
    }

    @Test fun `adding a capture makes kept answers stale and the change flow emit`() = runTest {
        val layer = layer().also { it.signIn() }
        layer.writes.attach(server)
        var requests = 0
        val transmit: suspend (ApiRequest) -> ApiResponse = {
            requests += 1
            dayAnswer("2026-11-28")
        }
        layer.read(ADA_SESSION, TOMORROW_READ, transmit)
        layer.read(ADA_SESSION, TOMORROW_READ, transmit)
        assertEquals(1, requests, "a fresh answer is given without a request")
        val changes = emissions(layer)

        layer.add("Today's capture")
        runCurrent()

        assertEquals(1, changes())
        layer.read(ADA_SESSION, TOMORROW_READ, transmit)
        assertEquals(2, requests)
    }

    @Test fun `a capture the server created makes kept answers stale and the change flow emit`() = runTest {
        val layer = layer().also { it.signIn() }
        layer.writes.attach(server)
        val sent = CompletableDeferred<Unit>()
        server.item = {
            sent.await()
            CREATED
        }
        var requests = 0
        val transmit: suspend (ApiRequest) -> ApiResponse = {
            requests += 1
            dayAnswer("2026-11-28")
        }
        layer.add("Today's capture")
        runCurrent()
        layer.read(ADA_SESSION, TOMORROW_READ, transmit)
        layer.read(ADA_SESSION, TOMORROW_READ, transmit)
        assertEquals(1, requests)
        val changes = emissions(layer)

        sent.complete(Unit)
        runCurrent()

        assertEquals(1, changes())
        layer.read(ADA_SESSION, TOMORROW_READ, transmit)
        assertEquals(2, requests)
    }

    @Test fun `a capture shows only in the answer of its own day`() = runTest {
        val layer = layer().also { it.signIn() }
        layer.add("For today")
        layer.add("For tomorrow", day = TOMORROW)

        assertEquals(listOf("c1"), layer.read(ADA_SESSION, TODAY_READ) { dayAnswer("2026-11-27") }.inboxIds())
        assertEquals(listOf("c2"), layer.read(ADA_SESSION, TOMORROW_READ) { dayAnswer("2026-11-28") }.inboxIds())
    }

    @Test fun `the captures of another person never show`() = runTest {
        val layer = layer()
        layer.signIn(BOB_SESSION, BOB)
        layer.add("Bob's capture", session = BOB_SESSION)
        layer.signIn()
        layer.add("Ada's capture")

        val ada = layer.read(ADA_SESSION, TODAY_READ) { dayAnswer("2026-11-27") }
        layer.signIn(BOB_SESSION, BOB)
        val bob = layer.read(BOB_SESSION, TODAY_READ) { dayAnswer("2026-11-27") }

        assertEquals(listOf("c2"), ada.inboxIds())
        assertEquals(listOf("c1"), bob.inboxIds())
    }

    @Test fun `a capture shows without an emoji when the types are not kept`() = runTest {
        val layer = layer().also { it.signIn() }
        layer.add("Typed", typeId = "t1")

        val entry = layer.read(ADA_SESSION, TODAY_READ) { dayAnswer("2026-11-27") }.inbox().single()

        assertEquals(
            Json.parseToJsonElement(
                """{"id":"c1","time":"08:15","text":"Typed","type":null,"status":"waiting","attachments":[]}""",
            ),
            entry,
        )
    }

    @Test fun `the waiting captures follow the server's entries in the order they were made and never twice`() {
        fun capture(id: String, day: String, createdAt: String) =
            KeptCapture(CAPTURE_FILE_VERSION, id, "text $id", day, "09:00", createdAt = createdAt)
        val captures = listOf(
            capture("c1", "2026-11-27", "2026-11-27T08:00:00Z"),
            capture("c2", "2026-11-27", "2026-11-27T08:01:00Z"),
            capture("c3", "2026-11-28", "2026-11-27T08:02:00Z"),
            capture("c4", "2026-11-27", "2026-11-27T08:03:00Z"),
        )
        val answer = dayAnswer("2026-11-27", """{"id":"s1"}""", """{"id":"c2"}""")

        val projected = CaptureProjection.apply(TODAY_READ, answer, captures, emptyMap())

        assertEquals(listOf("s1", "c2", "c1", "c4"), projected.inboxIds())
    }

    @Test fun `only a day of the diary that the server answered is projected`() {
        val captures = listOf(KeptCapture(CAPTURE_FILE_VERSION, "c1", "t", "2026-11-27", "09:00", createdAt = "x"))
        val week = ApiRequest(HttpMethod.Get, "/api/journal/periods/week/2026-W48")
        val failure = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
        val week48 = dayAnswer("2026-11-27")
        val notJson = ApiResponse.Success(200, "not json")

        assertSame(week48, CaptureProjection.apply(week, week48, captures, emptyMap()))
        assertSame(failure, CaptureProjection.apply(TODAY_READ, failure, captures, emptyMap()))
        assertSame(notJson, CaptureProjection.apply(TODAY_READ, notJson, captures, emptyMap()))
    }
}
