package cz.alldots.app.sdk

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import cz.alldots.app.core.AppPlatform
import cz.alldots.app.core.DeviceInfo
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.data.ApiClient
import cz.alldots.app.data.HttpAuthRepository
import cz.alldots.app.data.OfflineLayer
import cz.alldots.app.presentation.Failed
import cz.alldots.app.presentation.InboxCaptureAttachmentSource
import cz.alldots.app.presentation.InboxCaptureTypeState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.Collections
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val TYPES_ANSWER =
    """{"types":[{"id":"t1","label":"Receipt","emoji":"R"},{"id":"t2","label":"Idea","emoji":"I"}]}"""
private const val SESSION_ANSWER = """{"user":{"id":"u1","email":"ada@example.com","locale":"en","role":"member"}}"""
private const val CREATED_ANSWER = """{"item":{"id":"i1"},"attachments":[]}"""
private val DEVICE = DeviceInfo(AppPlatform.IOS, "00000000-0000-4000-8000-000000000000", "Device", "iphone", "0", "0")

/** One request the test server received: its method, its path, its `Idempotency-Key` and its body. */
private data class Received(val method: String, val path: String, val key: String?, val body: String)

/**
 * A Alldots server on the loopback interface. [status] is the status every request gets, `200` (or `201` for an item)
 * with the answers above; anything else answers that status with an empty error. [itemStatus], when set, is the status
 * of `POST /api/inbox/items` alone.
 */
private class TestServer {
    @Volatile var status = 200
    @Volatile var itemStatus: Int? = null
    val received: MutableList<Received> = Collections.synchronizedList(mutableListOf())
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply {
        createContext("/") { exchange -> answer(exchange) }
        start()
    }
    val url = "http://127.0.0.1:${server.address.port}"

    private fun answer(exchange: HttpExchange) {
        val path = exchange.requestURI.path
        val body = exchange.requestBody.readBytes().decodeToString()
        received += Received(exchange.requestMethod, path, exchange.requestHeaders.getFirst("Idempotency-Key"), body)
        val refusedItem = itemStatus.takeIf { path == "/api/inbox/items" }
        val (code, text) = when {
            status != 200 -> status to """{"error":{"code":"failed"}}"""
            refusedItem != null -> refusedItem to """{"error":{"code":"failed"}}"""
            path == "/api/auth/session" -> 200 to SESSION_ANSWER
            path == "/api/inbox-types" -> 200 to TYPES_ANSWER
            path == "/api/inbox/items" -> 201 to CREATED_ANSWER
            else -> 404 to """{"error":{"code":"notFound"}}"""
        }
        val bytes = text.encodeToByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(code, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    fun items(): List<Received> = synchronized(received) { received.filter { it.path == "/api/inbox/items" } }

    fun stop() = server.stop(0)
}

/**
 * The SDK of the app's Inbox intents over a real server on the loopback interface and a data directory of its own,
 * whose `OfflineLayer` it shares with a window signed in to the same session storage.
 */
class InboxCaptureSDKTest {
    private val server = TestServer()
    private val directory: String = Files.createTempDirectory("alldots-inbox-capture-sdk").toString()
    private val storage = InMemorySessionStorage().apply { save(StoredSession(server.url, "tok")) }

    @AfterTest fun stopServer() = server.stop()

    /** A window signs in as the person of the session, so the device keeps that person for the outbox. */
    private suspend fun windowRestores() {
        window().restore()
    }

    /** A window's auth over the session and the layer; a `401` of its sender signs the session out. */
    private fun window() = HttpAuthRepository(ApiClient(), storage, DEVICE, offline = OfflineLayer.shared(directory))

    /** Captures with the item refused as `401`: the session ends only when a window's sender sent the capture. */
    private suspend fun sendRefusedCapture(sdk: InboxCaptureSDK) {
        server.itemStatus = 401
        assertEquals(InboxCaptureAnswer.Kept, sdk.capture("Buy milk", "2026-11-27", "07:45", null, null))
        assertFalse(sdk.send())
        assertTrue(server.items().isNotEmpty())
    }

    @Test fun `with a window first the captures go out through the window's sender, not the SDK's`() = runTest {
        windowRestores()
        val sdk = InboxCaptureSDK(storage, directory)

        sendRefusedCapture(sdk)
        assertNull(storage.load())
    }

    @Test fun `a window created after the SDK takes over its sender`() = runTest {
        val sdk = InboxCaptureSDK(storage, directory)
        windowRestores()

        sendRefusedCapture(sdk)
        assertNull(storage.load())
    }

    @Test fun `without a window the SDK's own sender sends, and its 401 keeps the session`() = runTest {
        // The person was kept by a window of an earlier process; this one has no window.
        val earlier = Files.createTempDirectory("alldots-inbox-capture-sdk-earlier").toString()
        HttpAuthRepository(ApiClient(), storage, DEVICE, offline = OfflineLayer.shared(earlier)).restore()
        File(earlier, "offline").copyRecursively(File(directory, "offline"))
        val sdk = InboxCaptureSDK(storage, directory)

        sendRefusedCapture(sdk)
        assertNotNull(storage.load())
    }

    private fun keptCaptures(): List<File> =
        File(directory, "captures").walkTopDown().filter { it.isFile && it.extension == "json" }.toList()

    @Test fun `the types are read from the server and answered from the kept answer when it cannot answer`() =
        runTest {
            val sdk = InboxCaptureSDK(storage, directory)
            val types = listOf(InboxCaptureTypeState("t1", "Receipt", "R"), InboxCaptureTypeState("t2", "Idea", "I"))
            assertEquals(InboxCaptureTypesAnswer.Loaded(types), sdk.types())

            server.status = 503
            val offline = InboxCaptureSDK(storage, directory)
            assertEquals(InboxCaptureTypesAnswer.Loaded(types), offline.types())
        }

    @Test fun `without a kept answer a failed read of the types is refused with its kind`() = runTest {
        server.status = 503
        assertEquals(
            InboxCaptureTypesAnswer.Refused(Failed(FailureKind.UNAVAILABLE)),
            InboxCaptureSDK(storage, directory).types(),
        )
    }

    @Test fun `a 401 refuses the call but keeps the session for the next window`() = runTest {
        server.status = 401
        val sdk = InboxCaptureSDK(storage, directory)
        assertEquals(InboxCaptureTypesAnswer.Refused(Failed(FailureKind.UNAUTHORIZED)), sdk.types())
        assertNotNull(storage.load())
        assertTrue(sdk.signedIn())
    }

    @Test fun `a capture made while the server cannot answer waits in the outbox and reaches the Inbox later`() =
        runTest {
            windowRestores()
            server.status = 503
            val sdk = InboxCaptureSDK(storage, directory)
            assertEquals(InboxCapturesWaiting.NOTHING, sdk.capturesWait())

            assertEquals(InboxCaptureAnswer.Kept, sdk.capture("  Buy milk ", "2026-11-27", "07:45", "t1", null))
            assertEquals(InboxCapturesWaiting.WAITING, sdk.capturesWait())
            val kept = keptCaptures().single().readText()
            assertTrue(""""text":"Buy milk"""" in kept, kept)
            assertTrue(""""day":"2026-11-27"""" in kept, kept)
            assertTrue(""""time":"07:45"""" in kept, kept)
            assertTrue(""""typeId":"t1"""" in kept, kept)
            assertFalse(sdk.send())
            assertEquals(1, keptCaptures().size)
            assertEquals(
                InboxCapturesWaiting.WAITING,
                sdk.capturesWait(),
                "a capture the server did not take still waits",
            )

            server.status = 200
            assertTrue(sdk.send())
            assertEquals(emptyList(), keptCaptures())
            assertEquals(InboxCapturesWaiting.NOTHING, sdk.capturesWait())
            val delivered = server.items().last()
            assertEquals("POST", delivered.method)
            assertNotNull(delivered.key)
            assertTrue(""""text":"Buy milk"""" in delivered.body, delivered.body)
            assertTrue(""""date":"2026-11-27"""" in delivered.body, delivered.body)
            assertTrue(""""time":"07:45"""" in delivered.body, delivered.body)
            assertTrue(""""typeId":"t1"""" in delivered.body, delivered.body)
        }

    @Test fun `a capture without a type is sent without one`() = runTest {
        windowRestores()
        val sdk = InboxCaptureSDK(storage, directory)

        assertEquals(InboxCaptureAnswer.Kept, sdk.capture("Call Bob", "2026-11-27", "08:00", null, null))
        assertTrue(sdk.send())
        val delivered = server.items().last().body
        assertTrue(""""text":"Call Bob"""" in delivered, delivered)
        assertFalse("typeId" in delivered, delivered)
    }

    @Test fun `a capture with a file keeps its bytes beside it`() = runTest {
        windowRestores()
        server.status = 503
        val file = InboxCaptureFileInput("scan.pdf", "application/pdf", "AQID", InboxCaptureAttachmentSource.CAMERA)

        val sdk = InboxCaptureSDK(storage, directory)
        assertEquals(InboxCaptureAnswer.Kept, sdk.capture("", "2026-11-27", "08:00", null, file))
        val json = keptCaptures().single()
        assertTrue(""""name":"scan.pdf"""" in json.readText(), json.readText())
        val bytes = File(json.parentFile, "${json.nameWithoutExtension}.bin").readBytes()
        assertEquals(listOf<Byte>(1, 2, 3), bytes.toList())
    }

    @Test fun `a blank text, a day that is none and a file that does not decode are refused and nothing is kept`() =
        runTest {
            windowRestores()
            val sdk = InboxCaptureSDK(storage, directory)
            val invalid = InboxCaptureAnswer.Refused(Failed(FailureKind.INVALID_DATA))
            val broken = InboxCaptureFileInput("scan.pdf", "application/pdf", "*", InboxCaptureAttachmentSource.FILES)

            assertEquals(invalid, sdk.capture("   ", "2026-11-27", "08:00", null, null))
            assertEquals(invalid, sdk.capture("Text", "27. 11. 2026", "08:00", null, null))
            assertEquals(invalid, sdk.capture("Text", "2026-11-27", "08:00", null, broken))
            assertEquals(emptyList(), keptCaptures())
            assertEquals(emptyList(), server.items())
        }

    @Test fun `nobody signed in or no person kept refuses the capture as unauthorized and keeps nothing`() = runTest {
        val unauthorized = InboxCaptureAnswer.Refused(Failed(FailureKind.UNAUTHORIZED))
        val noPerson = InboxCaptureSDK(storage, directory)
        assertEquals(unauthorized, noPerson.capture("Text", "2026-11-27", "08:00", null, null))

        val signedOut = InboxCaptureSDK(InMemorySessionStorage(), directory)
        assertFalse(signedOut.signedIn())
        assertEquals(unauthorized, signedOut.capture("Text", "2026-11-27", "08:00", null, null))
        assertFalse(signedOut.send())
        assertEquals(InboxCapturesWaiting.NOTHING, noPerson.capturesWait())
        assertEquals(InboxCapturesWaiting.NOTHING, signedOut.capturesWait())
        assertEquals(emptyList(), keptCaptures())
        assertEquals(emptyList(), server.items())
    }

    @Test fun `a count of the waiting captures that fails is not known rather than nothing waiting`() = runTest {
        assertEquals(InboxCapturesWaiting.WAITING, waitingAnswer { true })
        assertEquals(InboxCapturesWaiting.NOTHING, waitingAnswer { false })
        assertEquals(InboxCapturesWaiting.UNKNOWN, waitingAnswer { error("the people store could not be read") })
        assertFailsWith<CancellationException> { waitingAnswer { throw CancellationException("cancelled") } }
    }
}
