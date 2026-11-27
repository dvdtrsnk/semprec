package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.InboxCapture
import cz.semprec.app.domain.InboxCaptureFile
import cz.semprec.app.domain.InboxCaptureSource
import cz.semprec.app.domain.OfflineStatus
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SessionUser
import io.ktor.client.engine.mock.MockEngine
import io.ktor.http.HttpMethod
import io.ktor.util.hex
import io.ktor.util.sha1
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlin.time.TestTimeSource

private const val OUTBOX_SERVER = "https://s.example"
private val OUTBOX_SESSION = StoredSession(OUTBOX_SERVER, "tok")
private val OUTBOX_PERSON = SessionUser("u1", "ada@example.com", "en", "member")
private val OUTBOX_OTHER = SessionUser("u2", "bob@example.com", "en", "member")
private val OUTBOX_DAY = CalendarDay(2026, 11, 27)
private val OUTBOX_NO_ANSWER = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
private val OUTBOX_CREATED = ApiResponse.Success(201, """{"item":{"id":"i1"},"attachments":[]}""")

private fun blobAnswer(id: String) =
    ApiResponse.Success(201, """{"blobId":"$id","byteSize":3,"mimeType":"image/png"}""")

private fun refusal(status: Int, details: String? = null): ApiResponse.Failure {
    val body = details?.let { """{"error":{"code":"validation_failed","details":$it}}""" }
        ?: """{"error":{"code":"validation_failed"}}"""
    return ApiResponse.Failure(if (status == 401) FailureKind.UNAUTHORIZED else FailureKind.REJECTED, status, body)
}

/**
 * The server as the window's sender reaches it: [item] answers `POST /api/inbox/items` and [blob] answers
 * `POST /api/blobs`; [log] records each request in order (`upload` or `item <Idempotency-Key>`), and [inFlight]
 * tracks how many were under way at once.
 */
private class CaptureServer : QueueSender {
    var session: StoredSession? = OUTBOX_SESSION
    val items = mutableListOf<ApiRequest>()
    val uploads = mutableListOf<RawBody>()
    val log = mutableListOf<String>()
    var item: suspend (ApiRequest) -> ApiResponse = { OUTBOX_CREATED }
    var blob: suspend (RawBody) -> ApiResponse = { blobAnswer("b1") }
    var inFlight = 0
    var mostInFlight = 0

    override fun account(): String? = session?.let(::accountKey)

    override fun session(): StoredSession? = session

    override suspend fun send(request: ApiRequest): ApiResponse = counted {
        items += request
        log += "item ${request.idempotencyKey()}"
        item(request)
    }

    override suspend fun upload(path: String, body: RawBody): ApiResponse = counted {
        assertEquals(INBOX_BLOBS_PATH, path)
        uploads += body
        log += "upload"
        blob(body)
    }

    private suspend fun counted(answer: suspend () -> ApiResponse): ApiResponse {
        inFlight += 1
        mostInFlight = maxOf(mostInFlight, inFlight)
        return try {
            answer()
        } finally {
            inFlight -= 1
        }
    }
}

private fun ApiRequest.idempotencyKey(): String? = extraHeaders.singleOrNull { it.first == "Idempotency-Key" }?.second

private fun ApiRequest.json(): JsonObject = Json.parseToJsonElement(checkNotNull(body)).jsonObject

private fun ApiRequest.blobId(): String =
    json().getValue("attachments").jsonArray.single().jsonObject.getValue("blobId").jsonPrimitive.content

@OptIn(ExperimentalCoroutinesApi::class, ExperimentalTime::class)
class CaptureOutboxTest {
    private val directory = newTestDirectory()
    private val server = CaptureServer()
    private var now = Instant.parse("2026-11-27T10:00:00Z")
    private var lastId = 0
    private var jitter = 0.0

    private fun TestScope.layer(): OfflineLayer = OfflineLayer(
        OfflineStore(directory, StandardTestDispatcher(testScheduler)),
        backgroundScope,
        TestTimeSource(),
        QueueClock(now = { now.toString() }, random = { jitter }, today = { "2026-11-27" }),
        newId = { "c${++lastId}" },
    ).also { it.writes.attach(server) }

    private suspend fun OfflineLayer.signIn(
        session: StoredSession = OUTBOX_SESSION,
        person: SessionUser = OUTBOX_PERSON,
    ) {
        server.session = session
        store.people.keep(accountKey(session), person)
    }

    private fun file(bytes: ByteArray = byteArrayOf(1, 2, 3)) =
        InboxCaptureFile("scan.png", "image/png", bytes, InboxCaptureSource.CAMERA)

    private fun capture(text: String = "Call the plumber", typeId: String? = null, file: InboxCaptureFile? = null) =
        InboxCapture(text, OUTBOX_DAY, "08:15", typeId, file)

    /** Adds [capture] one second after the one before, so the order they were made in is their order in time. */
    private suspend fun OfflineLayer.add(capture: InboxCapture = capture()): RepositoryResult<Unit> {
        now += 1.seconds
        return captures.add(checkNotNull(server.session), capture)
    }

    /** The directory of [person]'s captures: named by the SHA-1 of the server and the person, not the token. */
    private fun ownerDirectory(person: SessionUser = OUTBOX_PERSON): String =
        "$directory/captures/${hex(sha1("$OUTBOX_SERVER\n${person.id}".encodeToByteArray()))}"

    private fun files(person: SessionUser = OUTBOX_PERSON): List<String> =
        listCacheDirectory(ownerDirectory(person)).sorted()

    private fun kept(id: String): KeptCapture {
        val text = checkNotNull(readCacheFile("${ownerDirectory()}/$id.json"))
        return Json.decodeFromString(KeptCapture.serializer(), text)
    }

    private fun offline() {
        server.item = { OUTBOX_NO_ANSWER }
        server.blob = { OUTBOX_NO_ANSWER }
    }

    private fun online() {
        server.item = { OUTBOX_CREATED }
        server.blob = { blobAnswer("b1") }
    }

    @Test fun `a capture with a file made offline is kept and once the server answers is uploaded and created once`() =
        runTest {
            val layer = layer()
            layer.signIn()
            offline()
            assertEquals(RepositoryResult.Content(Unit), layer.add(capture(text = "", file = file())))
            runCurrent()
            assertEquals(listOf("c1.bin", "c1.json"), files())
            assertEquals(listOf<Byte>(1, 2, 3), readCacheBytes("${ownerDirectory()}/c1.bin")?.toList())
            assertTrue(server.items.isEmpty(), "The upload got no answer, so the item was not sent")

            online()
            server.log.clear()
            assertTrue(layer.captures.send())

            assertEquals(listOf("upload", "item c1"), server.log)
            assertEquals(listOf<Byte>(1, 2, 3), server.uploads.last().bytes.toList())
            assertEquals("image/png", server.uploads.last().mimeType)
            val sent = server.items.single()
            assertEquals(HttpMethod.Post, sent.method)
            assertEquals(INBOX_ITEMS_PATH, sent.path)
            val attachment = sent.json().getValue("attachments").jsonArray.single().jsonObject
            assertEquals("b1", attachment.getValue("blobId").jsonPrimitive.content)
            assertEquals("camera", attachment.getValue("source").jsonPrimitive.content)
            assertEquals("2026-11-27", sent.json().getValue("date").jsonPrimitive.content)
            assertEquals("08:15", sent.json().getValue("time").jsonPrimitive.content)
            assertEquals("typed", sent.json().getValue("captureChannel").jsonPrimitive.content)
            assertTrue(files().isEmpty())
        }

    @Test fun `an item that got no answer after its upload is sent again without uploading with the same key`() =
        runTest {
            val layer = layer()
            layer.signIn()
            server.item = { OUTBOX_NO_ANSWER }
            layer.add(capture(file = file()))
            runCurrent()
            assertEquals("b1", kept("c1").blobId)
            assertNotNull(kept("c1").uploadedAt)

            online()
            server.blob = { error("The file was uploaded already") }
            assertTrue(layer.captures.send())

            assertEquals(listOf("upload", "item c1", "item c1"), server.log)
            assertEquals("b1", server.items.last().blobId())
            assertTrue(files().isEmpty())
        }

    @Test fun `a new layer over the same directory sends the captures the files hold`() = runTest {
        val first = layer()
        first.signIn()
        offline()
        first.add(capture(text = "Before the restart"))
        runCurrent()

        online()
        server.items.clear()
        val second = layer()
        assertTrue(second.captures.send())
        assertEquals("Before the restart", server.items.single().json().getValue("text").jsonPrimitive.content)
        assertTrue(files().isEmpty())
    }

    @Test fun `bytes without their capture are deleted when the outbox lists the directory`() = runTest {
        val layer = layer()
        layer.signIn()
        writeCacheBytes("${ownerDirectory()}/stray.bin", byteArrayOf(9))
        layer.captures.send()
        assertTrue(files().isEmpty())
    }

    @Test fun `a capture whose bytes are missing keeps waiting counted and is never deleted`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add(capture(file = file()))
        runCurrent()
        deleteCachePath("${ownerDirectory()}/c1.bin")

        online()
        server.log.clear()
        assertFalse(layer.captures.send())
        assertFalse(layer.captures.send())

        assertTrue(server.log.isEmpty(), "Nothing can be uploaded and the item names a file, so nothing is sent")
        assertEquals(listOf("c1.json"), files())
        assertEquals(0, kept("c1").attempts)
        assertEquals(1, layer.status.first().waiting)
    }

    @Test fun `a capture whose upload is recorded but whose bytes are missing counts as refused when its blob is`() =
        runTest {
            val layer = layer()
            layer.signIn()
            server.item = { OUTBOX_NO_ANSWER }
            layer.add(capture(file = file()))
            runCurrent()
            deleteCachePath("${ownerDirectory()}/c1.bin")

            server.item = { refusal(400, """{"field":"attachments"}""") }
            server.log.clear()
            assertFalse(layer.captures.send())

            assertEquals(listOf("item c1"), server.log)
            assertEquals(1, kept("c1").attempts)
            assertEquals((now + 1.hours).toString(), kept("c1").nextAttemptAt)
        }

    @Test fun `a capture JSON that cannot be read stays and is counted`() = runTest {
        val layer = layer()
        layer.signIn()
        writeCacheFile("${ownerDirectory()}/broken.json", "{not json")
        assertFalse(layer.captures.send())
        assertTrue(server.log.isEmpty())
        assertEquals(listOf("broken.json"), files())
        assertEquals(1, layer.status.first().waiting)
    }

    @Test fun `ending the session and signing the same person in with a new token leave the captures to send`() =
        runTest {
            val layer = layer()
            layer.signIn()
            offline()
            layer.add(capture(file = file()))
            runCurrent()

            layer.clear()
            assertEquals(listOf("c1.bin", "c1.json"), files())
            assertEquals(0, layer.status.first().waiting)

            online()
            val again = StoredSession(OUTBOX_SERVER, "tok-2")
            layer.signIn(again)
            server.log.clear()
            assertTrue(layer.captures.send())
            assertEquals(listOf("upload", "item c1"), server.log)
            assertTrue(files().isEmpty())
        }

    @Test fun `keeping the answers of another account leaves the captures in place`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add()
        runCurrent()

        layer.store.answers.keep("another-account", "key", KeptAnswer(200, "{}", null))

        assertEquals(listOf("c1.json"), files())
    }

    @Test fun `a capture of another person is not sent while someone else is signed in`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add()
        runCurrent()

        online()
        layer.signIn(StoredSession(OUTBOX_SERVER, "tok-bob"), OUTBOX_OTHER)
        server.log.clear()
        assertTrue(layer.captures.send(), "Bob has nothing left to send")

        assertTrue(server.log.isEmpty())
        assertEquals(listOf("c1.json"), files())
        assertEquals(0, layer.status.first().waiting)
    }

    @Test fun `a capture made while no person is known is refused and nothing is written`() = runTest {
        val layer = layer()
        val result = layer.captures.add(OUTBOX_SESSION, capture(file = file()))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), result)
        assertTrue(listCacheDirectory("$directory/captures").isEmpty())
    }

    @Test fun `a capture whose files cannot be written is a failure`() = runTest {
        val layer = layer()
        layer.signIn()
        // A file where the captures directory belongs makes every write under it fail.
        writeCacheFile("$directory/captures", "in the way")
        val result = layer.add(capture(file = file()))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), result)
    }

    @Test fun `a server error a throttle and a refused session keep the capture with no attempt limit`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add()
        runCurrent()

        for (answer in listOf(
            ApiResponse.Failure(FailureKind.UNAVAILABLE, 503),
            ApiResponse.Failure(FailureKind.UNAVAILABLE, 429),
            refusal(401),
        )) {
            server.item = { answer }
            repeat(10) { assertFalse(layer.captures.send()) }
        }

        assertEquals(listOf("c1.json"), files())
        assertEquals(0, kept("c1").attempts)
        assertNull(kept("c1").nextAttemptAt)
        online()
        assertTrue(layer.captures.send())
    }

    @Test fun `a round without an answer is tried again after a backoff doubling from 1 s to 60 s`() = runTest {
        jitter = 1.0
        val layer = layer()
        layer.signIn()
        val times = mutableListOf<Long>()
        server.item = {
            times += testScheduler.currentTime
            OUTBOX_NO_ANSWER
        }
        layer.add()
        runCurrent()
        advanceTimeBy(5.minutes)

        val waits = times.zipWithNext { earlier, later -> later - earlier }.take(8)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L), waits)

        online()
        advanceTimeBy(1.minutes)
        assertTrue(files().isEmpty())
    }

    /** Adds a capture the server answers with [answer] and tells whether a retry followed it after the backoff. */
    private suspend fun TestScope.retriedAfter(answer: ApiResponse.Failure): Boolean {
        val layer = layer()
        layer.signIn()
        server.item = { answer }
        layer.add()
        runCurrent()
        assertEquals(1, server.items.size)
        advanceTimeBy(1_001)
        assertEquals(listOf("c1.json"), files())
        return server.items.size == 2
    }

    @Test fun `a server error is tried again after the backoff`() = runTest {
        assertTrue(retriedAfter(ApiResponse.Failure(FailureKind.UNAVAILABLE, 503)))
    }

    @Test fun `a throttle is tried again after the backoff`() = runTest {
        assertTrue(retriedAfter(ApiResponse.Failure(FailureKind.UNAVAILABLE, 429)))
    }

    @Test fun `a refused session ends the round until the next trigger`() = runTest {
        assertFalse(retriedAfter(refusal(401)))
        advanceTimeBy(2.minutes)
        assertEquals(1, server.items.size)
    }

    @Test fun `a busy type keeps the capture with its type and is tried again after the backoff`() = runTest {
        val layer = layer()
        layer.signIn()
        server.item = { refusal(409, """{"field":"typeId"}""") }
        layer.add(capture(typeId = "t1"))
        runCurrent()
        assertEquals(listOf("item c1"), server.log, "A busy type is not sent again without it")
        assertEquals("t1", kept("c1").typeId)
        assertEquals(0, kept("c1").attempts)

        server.item = { OUTBOX_CREATED }
        advanceTimeBy(1_001)
        assertEquals(listOf("item c1", "item c1"), server.log)
        assertEquals("t1", server.items.last().json().getValue("typeId").jsonPrimitive.content)
        assertTrue(files().isEmpty())
    }

    @Test fun `a refusal naming the type sends the capture again at once without it and writes the change`() =
        runTest {
            val layer = layer()
            layer.signIn()
            server.item = { request ->
                if ("typeId" in request.json()) refusal(400, """{"field":"typeId"}""") else OUTBOX_NO_ANSWER
            }
            layer.add(capture(typeId = "t1"))
            runCurrent()

            assertEquals(listOf("item c1", "item c1"), server.log.take(2))
            assertEquals("t1", server.items[0].json().getValue("typeId").jsonPrimitive.content)
            assertFalse("typeId" in server.items[1].json())
            assertNull(kept("c1").typeId)

            online()
            assertTrue(layer.captures.send())
            assertFalse("typeId" in server.items.last().json())
        }

    @Test fun `a refusal naming the blob uploads the file once more and sends the item again`() = runTest {
        val layer = layer()
        layer.signIn()
        var uploads = 0
        server.blob = { blobAnswer("b${++uploads}") }
        server.item = { request ->
            if (request.blobId() == "b1") refusal(400, """{"field":"attachments"}""") else OUTBOX_CREATED
        }
        layer.add(capture(file = file()))
        runCurrent()

        assertEquals(listOf("upload", "item c1", "upload", "item c1"), server.log)
        assertTrue(files().isEmpty())
    }

    @Test fun `a blob refused again in the same round counts as refused and waits an hour`() = runTest {
        val layer = layer()
        layer.signIn()
        server.item = {
            ApiResponse.Failure(
                FailureKind.INVALID_DATA,
                415,
                """{"error":{"code":"unsupported_attachment_type","details":{"blobId":"b1","mimeType":"x/y"}}}""",
            )
        }
        layer.add(capture(file = file()))
        runCurrent()

        assertEquals(listOf("upload", "item c1", "upload", "item c1"), server.log)
        assertEquals(1, kept("c1").attempts)
        assertEquals((now + 1.hours).toString(), kept("c1").nextAttemptAt)
    }

    @Test fun `any other refusal waits an hour while the captures after it are sent`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add(capture(text = "Refused"))
        layer.add(capture(text = "Accepted"))
        runCurrent()

        server.item = { request ->
            if (request.json().getValue("text").jsonPrimitive.content == "Refused") refusal(400) else OUTBOX_CREATED
        }
        server.log.clear()
        assertFalse(layer.captures.send())
        assertEquals(listOf("item c1", "item c2"), server.log)
        assertEquals(listOf("c1.json"), files())
        assertEquals(1, kept("c1").attempts)

        server.log.clear()
        now += 59.minutes
        assertFalse(layer.captures.send())
        assertTrue(server.log.isEmpty(), "The refused capture waits an hour")

        server.item = { OUTBOX_CREATED }
        now += 1.minutes
        assertTrue(layer.captures.send())
        assertEquals(listOf("item c1"), server.log)
    }

    @Test fun `a refused upload waits an hour and is counted`() = runTest {
        val layer = layer()
        layer.signIn()
        server.blob = { ApiResponse.Failure(FailureKind.REJECTED, 413) }
        layer.add(capture(file = file()))
        runCurrent()

        assertEquals(listOf("upload"), server.log)
        assertEquals(1, kept("c1").attempts)
        assertEquals((now + 1.hours).toString(), kept("c1").nextAttemptAt)
    }

    @Test fun `an upload answer naming no blob counts as refused`() = runTest {
        val layer = layer()
        layer.signIn()
        server.blob = { ApiResponse.Success(201, """{"unexpected":true}""") }
        layer.add(capture(file = file()))
        runCurrent()

        assertEquals(listOf("upload"), server.log)
        assertEquals(1, kept("c1").attempts)
        assertNull(kept("c1").blobId)
    }

    @Test fun `captures go out in the order they were made one at a time and two triggers run one round`() =
        runTest {
            val layer = layer()
            layer.signIn()
            offline()
            layer.add(capture(text = "first"))
            layer.add(capture(text = "second"))
            layer.add(capture(text = "third"))
            runCurrent()

            server.item = {
                delay(10)
                OUTBOX_CREATED
            }
            server.items.clear()
            server.mostInFlight = 0
            val one = async { layer.captures.send() }
            val two = async { layer.captures.send() }
            layer.connected()
            assertTrue(one.await())
            assertTrue(two.await())
            runCurrent()

            assertEquals(
                listOf("first", "second", "third"),
                server.items.map { it.json().getValue("text").jsonPrimitive.content },
            )
            assertEquals(1, server.mostInFlight)
        }

    @Test fun `a capture is sent when added when the server is reached again the socket connects or a window starts`() =
        runTest {
            val layer = layer()
            layer.signIn()
            layer.add(capture(text = "added"))
            runCurrent()
            assertEquals(listOf("item c1"), server.log)

            offline()
            layer.add()
            runCurrent()
            online()
            server.log.clear()
            layer.observed(ApiResponse.Success(200, "{}"))
            runCurrent()
            assertEquals(listOf("item c2"), server.log)

            offline()
            layer.add()
            runCurrent()
            online()
            server.log.clear()
            layer.connected()
            runCurrent()
            assertEquals(listOf("item c3"), server.log)

            offline()
            layer.add()
            runCurrent()
            online()
            server.log.clear()
            val engine = MockEngine { error("No request") }
            val window = AuthenticatedApi(ApiClient(engine), InMemorySessionStorage(), offline = layer) {}
            layer.writes.attach(server)
            layer.warmUpWith(OfflineWarmup(window))
            runCurrent()
            assertEquals(listOf("item c4"), server.log)
        }

    @Test fun `a round ends when the session changes`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add(capture(text = "first"))
        layer.add(capture(text = "second"))
        runCurrent()

        // Keeping a person for another session would remove the person of this one, so the session switches to one
        // whose person is not known yet, as right after another sign-in.
        server.item = {
            server.session = StoredSession(OUTBOX_SERVER, "tok-next")
            OUTBOX_CREATED
        }
        server.log.clear()
        layer.captures.send()

        assertEquals(listOf("item c1"), server.log)
        assertEquals(listOf("c2.json"), files())
    }

    @Test fun `the waiting captures of the person signed in count in the status`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add()
        layer.add()
        runCurrent()
        assertEquals(OfflineStatus(offline = true, waiting = 2, failed = 0), layer.status.first())

        online()
        assertTrue(layer.captures.send())
        assertEquals(OfflineStatus(offline = false, waiting = 0, failed = 0), layer.status.first())
    }

    @Test fun `a capture the server created makes the change flow emit and a refused one does not`() = runTest {
        val layer = layer()
        layer.signIn()
        var changes = 0
        backgroundScope.launch { layer.changes.collect { changes += 1 } }
        runCurrent()

        server.item = { refusal(400) }
        layer.add()
        runCurrent()
        assertEquals(0, changes)

        server.item = { OUTBOX_CREATED }
        layer.add()
        runCurrent()
        assertEquals(1, changes)
    }

    @Test fun `without a person signed in a round sends nothing and answers that captures may be left`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add()
        runCurrent()

        server.session = null
        server.log.clear()
        assertFalse(layer.captures.send())
        assertTrue(server.log.isEmpty())
        assertEquals(0, layer.status.first().waiting)
    }

    @Test fun `whether captures wait is counted for the person signed in and is false with nobody signed in`() =
        runTest {
            val layer = layer()
            layer.signIn()
            assertFalse(layer.capturesWait(), "nothing was captured yet")

            offline()
            layer.add()
            runCurrent()
            assertTrue(layer.capturesWait())

            layer.signIn(StoredSession(OUTBOX_SERVER, "tok-bob"), OUTBOX_OTHER)
            assertFalse(layer.capturesWait(), "Bob has no capture of his own")

            server.session = null
            assertFalse(layer.capturesWait(), "nobody is signed in")

            layer.signIn()
            online()
            assertTrue(layer.captures.send())
            assertFalse(layer.capturesWait(), "the capture reached the server")
        }

    @Test fun `whether captures wait is false while no person is kept for the session`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        layer.add()
        runCurrent()

        server.session = StoredSession("https://other.example", "tok")
        assertFalse(layer.capturesWait())
    }

    @Test fun `an Inbox capture is not a route of the write queue`() {
        assertNull(QueuedRoute.of(HttpMethod.Post, INBOX_ITEMS_PATH))
    }

    @Test fun `the capture repository keeps a capture in the outbox when the device keeps data`() = runTest {
        val layer = layer()
        layer.signIn()
        offline()
        val storage = InMemorySessionStorage().apply { save(OUTBOX_SESSION) }
        val engine = MockEngine { error("A capture is not sent by the window") }
        val api = AuthenticatedApi(ApiClient(engine), storage, offline = layer) {}
        layer.writes.attach(server)

        val result = HttpInboxCaptureRepository(api).capture(capture(file = file()))

        assertIs<RepositoryResult.Content<Unit>>(result)
        assertEquals(listOf("c1.bin", "c1.json"), files())
    }

    @Test fun `the capture repository fails without writing when nobody is signed in`() = runTest {
        val layer = layer()
        val engine = MockEngine { error("No request") }
        val api = AuthenticatedApi(ApiClient(engine), InMemorySessionStorage(), offline = layer) {}

        val result = HttpInboxCaptureRepository(api).capture(capture())

        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), result)
        assertTrue(listCacheDirectory("$directory/captures").isEmpty())
    }
}
