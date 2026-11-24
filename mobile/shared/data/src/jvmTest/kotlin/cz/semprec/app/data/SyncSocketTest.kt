package cz.semprec.app.data

import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import cz.semprec.app.domain.note.PageChanges
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.path
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val WAIT_MILLIS = 10_000L
// Long enough for a reconnect after the test's 50 ms delay, which then never happens.
private const val QUIET_MILLIS = 600L
private const val SCHEMA = """{"databases":[{"databaseId":"db-events","key":"events"},""" +
    """{"databaseId":"db-mailboxes","key":"mailboxes"},{"databaseId":"db-notes","key":"notes"}]}"""

private fun itemFrame(databaseId: String) =
    """{"type":"invalidate","scope":"item","databaseId":"$databaseId","itemId":"i1","op":"update",""" +
        """"updatedAt":"2026-11-20T10:00:00.000Z"}"""

private fun docFrame(itemId: String) =
    """{"type":"invalidate","scope":"doc","docId":"d-$itemId","itemId":"$itemId","databaseId":"db-notes",""" +
        """"lastEditedAt":"2026-11-23T10:00:00.000Z"}"""

private fun notificationFrame(kind: String) =
    """{"type":"notification","notification":{"id":"n1","userId":"u1","kind":"$kind"}}"""

/**
 * A `WS /api/sync`, `GET /api/schema` and `GET /api/auth/session` on the loopback interface; it can be stopped and
 * started on its port. With [handshakeStatus] set, the socket's handshake is refused with that status instead, and
 * [sessionStatus] is what the session check answers.
 */
private class FakeSyncServer(val port: Int) {
    val connections = Channel<DefaultWebSocketServerSession>(Channel.UNLIMITED)
    val authorizations = Channel<String?>(Channel.UNLIMITED)
    val closes = Channel<CloseReason?>(Channel.UNLIMITED)
    val refusedHandshakes = Channel<Unit>(Channel.UNLIMITED)
    var handshakeStatus: HttpStatusCode? = null
    var sessionStatus: HttpStatusCode = HttpStatusCode.OK
    val schemaReads = AtomicInteger()
    private var server: EmbeddedServer<*, *>? = null

    fun start() {
        server = embeddedServer(CIO, port = port, host = "127.0.0.1") {
            install(WebSockets)
            // Answers before the WebSocket route, as the sync server refuses an upgrade before any socket exists.
            intercept(ApplicationCallPipeline.Plugins) {
                val refused = handshakeStatus
                if (refused != null && call.request.path() == "/api/sync") {
                    refusedHandshakes.send(Unit)
                    call.respond(refused)
                    finish()
                }
            }
            routing {
                get("/api/schema") {
                    schemaReads.incrementAndGet()
                    call.respondText(SCHEMA, ContentType.Application.Json)
                }
                get("/api/auth/session") { call.respondText("{}", ContentType.Application.Json, sessionStatus) }
                webSocket("/api/sync") {
                    authorizations.send(call.request.headers[HttpHeaders.Authorization])
                    connections.send(this)
                    for (ignored in incoming) Unit
                    closes.send(closeReason.await())
                }
            }
        }.start(wait = false)
    }

    /** Stops answering, as a network that went away: open sockets end without a close frame from the client. */
    fun stop() {
        server?.stop(gracePeriodMillis = 0, timeoutMillis = 500)
        server = null
    }
}

class SyncSocketTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val server = FakeSyncServer(ServerSocket(0).use { it.localPort })
    private val storage = InMemorySessionStorage()
    private val changes = SyncChanges()
    private var rejected = 0
    private val raises = SyncTopic.entries.associateWith { Channel<Unit>(Channel.UNLIMITED) }

    private val socket = SyncSocket(
        AuthenticatedApi(ApiClient(), storage) { rejected += 1 },
        changes,
        scope,
        reconnectDelay = { 50L },
        coalesceMillis = 200L,
    )

    init {
        raises.forEach { (topic, channel) -> scope.launch { changes.changes(topic).collect { channel.send(Unit) } } }
    }

    @AfterTest fun tearDown() {
        socket.stop()
        server.stop()
        scope.cancel()
    }

    private fun signIn() = storage.save(StoredSession("http://127.0.0.1:${server.port}", "tok"))

    private suspend fun raised(topic: SyncTopic) = withTimeout(WAIT_MILLIS) { raises.getValue(topic).receive() }

    private suspend fun everyTopicRaised() = SyncTopic.entries.forEach { raised(it) }

    private fun pendingRaises(topic: SyncTopic): Int {
        var count = 0
        while (raises.getValue(topic).tryReceive().isSuccess) count += 1
        return count
    }

    private suspend fun connection() = withTimeout(WAIT_MILLIS) { server.connections.receive() }

    @Test fun `connects with the stored session and raises the topics its frames concern`() = runBlocking<Unit> {
        server.start()
        signIn()
        socket.start()
        socket.start()
        val session = connection()
        assertEquals("Bearer tok", withTimeout(WAIT_MILLIS) { server.authorizations.receive() })
        everyTopicRaised()

        repeat(3) { session.send(Frame.Text(itemFrame("db-events"))) }
        raised(SyncTopic.CALENDAR)
        session.send(Frame.Text("not a frame"))
        session.send(Frame.Text(itemFrame("db-notes")))
        session.send(Frame.Text(notificationFrame("approval_pending")))
        session.send(Frame.Text(itemFrame("db-mailboxes")))
        raised(SyncTopic.MAIL_ACCOUNTS)
        session.send(Frame.Text(notificationFrame("calendar_invitation")))
        raised(SyncTopic.INVITATIONS)

        assertEquals(0, pendingRaises(SyncTopic.CALENDAR))
        assertEquals(0, pendingRaises(SyncTopic.MAIL_ACCOUNTS))
        assertNull(withTimeoutOrNull(QUIET_MILLIS) { server.connections.receive() })
    }

    @Test fun `a connect and every frame make what the offline layer keeps read again`() = runBlocking<Unit> {
        val layer = OfflineLayer(OfflineStore(newTestDirectory()), scope)
        val api = AuthenticatedApi(ApiClient(), storage, offline = layer) { rejected += 1 }
        val offlineSocket = SyncSocket(api, changes, scope, { 50L }, 200L, layer)
        server.start()
        signIn()
        api.send(HttpMethod.Get, "/api/schema")
        api.send(HttpMethod.Get, "/api/schema")
        assertEquals(1, server.schemaReads.get())

        offlineSocket.start()
        val session = connection()
        everyTopicRaised()
        // The socket read the schema after it connected, which made the kept one stale: it was answered at once and
        // read again behind, and the new answer is kept.
        schemaReadsReach(2)
        api.send(HttpMethod.Get, "/api/schema")
        assertEquals(2, server.schemaReads.get())

        session.send(Frame.Text(itemFrame("db-events")))
        raised(SyncTopic.CALENDAR)
        api.send(HttpMethod.Get, "/api/schema")
        schemaReadsReach(3)
        offlineSocket.stop()
    }

    private suspend fun schemaReadsReach(count: Int) {
        withTimeout(WAIT_MILLIS) { while (server.schemaReads.get() < count) delay(10) }
        assertEquals(count, server.schemaReads.get())
    }

    @Test fun `a frame that a page changed raises its item and no topic`() = runBlocking<Unit> {
        val pages = PageChanges()
        val named = Channel<String>(Channel.UNLIMITED)
        scope.launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
            pages.events.collect { named.send(it) }
        }
        val api = AuthenticatedApi(ApiClient(), storage) { rejected += 1 }
        val pageSocket = SyncSocket(api, changes, scope, { 50L }, 200L, pages = pages)
        server.start()
        signIn()
        pageSocket.start()
        val session = connection()
        everyTopicRaised()

        session.send(Frame.Text(docFrame("p1")))
        assertEquals("p1", withTimeout(WAIT_MILLIS) { named.receive() })
        session.send(Frame.Text(itemFrame("db-events")))
        raised(SyncTopic.CALENDAR)
        SyncTopic.entries.forEach { topic -> assertEquals(0, pendingRaises(topic), topic.name) }
        assertTrue(named.isEmpty)
        pageSocket.stop()
    }

    @Test fun `reconnects after the network returns and reads everything again`() = runBlocking<Unit> {
        server.start()
        signIn()
        socket.start()
        connection()
        everyTopicRaised()

        server.stop()
        assertNull(withTimeoutOrNull(QUIET_MILLIS) { server.connections.receive() })
        server.start()
        val again = connection()
        everyTopicRaised()
        again.send(Frame.Text(itemFrame("db-events")))
        raised(SyncTopic.CALENDAR)
        assertEquals(0, rejected)
    }

    @Test fun `a revoked session signs the window out and is not reconnected`() = runBlocking<Unit> {
        server.start()
        signIn()
        socket.start()
        connection().close(CloseReason(AuthenticatedApi.SESSION_REVOKED_CLOSE_CODE, "session revoked"))
        assertNull(withTimeoutOrNull(QUIET_MILLIS) { server.connections.receive() })
        assertEquals(1, rejected)
    }

    @Test fun `a handshake refused with 401 for the session signs the window out and is not retried`() =
        runBlocking<Unit> {
            server.handshakeStatus = HttpStatusCode.Unauthorized
            server.sessionStatus = HttpStatusCode.Unauthorized
            server.start()
            signIn()
            socket.start()
            withTimeout(WAIT_MILLIS) { server.refusedHandshakes.receive() }
            assertNull(withTimeoutOrNull(QUIET_MILLIS) { server.refusedHandshakes.receive() })
            assertEquals(1, rejected)
        }

    @Test fun `a refused handshake of a session the server still knows is retried`() = runBlocking<Unit> {
        server.handshakeStatus = HttpStatusCode.ServiceUnavailable
        server.start()
        signIn()
        socket.start()
        repeat(2) { withTimeout(WAIT_MILLIS) { server.refusedHandshakes.receive() } }
        assertEquals(0, rejected)
    }

    @Test fun `a socket that ended leaves nothing running in its client`() = runBlocking<Unit> {
        server.start()
        val engine = OkHttp.create()
        val client = ApiClient(engine)
        val clientJob = engine.coroutineContext[Job]!!
        val before = clientJob.activeDescendants()
        repeat(3) {
            val ended = scope.async { client.openSocket("http://127.0.0.1:${server.port}", "/api/sync", "tok") {} }
            connection()
            withTimeout(WAIT_MILLIS) { ended.await() }
        }
        assertEquals(before, withTimeout(WAIT_MILLIS) { settled { clientJob.activeDescendants() } })
        engine.close()
    }

    @Test fun `a socket the server closes for another reason is reconnected`() = runBlocking<Unit> {
        server.start()
        signIn()
        socket.start()
        connection().close(CloseReason(CloseReason.Codes.SERVICE_RESTART, "restart"))
        connection()
        assertEquals(0, rejected)
    }

    @Test fun `stop closes the socket normally and nothing reconnects until the next start`() = runBlocking<Unit> {
        server.start()
        signIn()
        socket.start()
        connection()
        socket.stop()
        assertEquals(CloseReason.Codes.NORMAL.code, withTimeout(WAIT_MILLIS) { server.closes.receive() }?.code)
        assertNull(withTimeoutOrNull(QUIET_MILLIS) { server.connections.receive() })
        socket.start()
        connection()
    }

    @Test fun `nobody signed in connects nothing until a start after signing in`() = runBlocking<Unit> {
        server.start()
        socket.start()
        assertNull(withTimeoutOrNull(QUIET_MILLIS) { server.connections.receive() })
        signIn()
        socket.start()
        connection()
        assertEquals(0, rejected)
    }
}

private fun Job.activeDescendants(): Int = children.filter { it.isActive }.sumOf { 1 + it.activeDescendants() }

/** [read] once it gives the same answer twice in a row, 50 ms apart. */
private suspend fun settled(read: () -> Int): Int {
    var last = read()
    while (true) {
        delay(50)
        val next = read()
        if (next == last) return next
        last = next
    }
}
