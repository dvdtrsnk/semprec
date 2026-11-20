package cz.semprec.app.data

import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.net.ServerSocket
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val WAIT_MILLIS = 10_000L
// Long enough for a reconnect after the test's 50 ms delay, which then never happens.
private const val QUIET_MILLIS = 600L
private const val SCHEMA = """{"databases":[{"databaseId":"db-events","key":"events"},""" +
    """{"databaseId":"db-mailboxes","key":"mailboxes"},{"databaseId":"db-notes","key":"notes"}]}"""

private fun itemFrame(databaseId: String) =
    """{"type":"invalidate","scope":"item","databaseId":"$databaseId","itemId":"i1","op":"update",""" +
        """"updatedAt":"2026-11-20T10:00:00.000Z"}"""

private fun notificationFrame(kind: String) =
    """{"type":"notification","notification":{"id":"n1","userId":"u1","kind":"$kind"}}"""

/** A `WS /api/sync` and `GET /api/schema` on the loopback interface; it can be stopped and started on its port. */
private class FakeSyncServer(val port: Int) {
    val connections = Channel<DefaultWebSocketServerSession>(Channel.UNLIMITED)
    val authorizations = Channel<String?>(Channel.UNLIMITED)
    val closes = Channel<CloseReason?>(Channel.UNLIMITED)
    private var server: EmbeddedServer<*, *>? = null

    fun start() {
        server = embeddedServer(CIO, port = port, host = "127.0.0.1") {
            install(WebSockets)
            routing {
                get("/api/schema") { call.respondText(SCHEMA, ContentType.Application.Json) }
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
