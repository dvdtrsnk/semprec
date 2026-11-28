package cz.alldots.app.data

import cz.alldots.app.domain.MailHistoryLogin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread
import kotlin.coroutines.CoroutineContext
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** A TLS record header that announces 16 KiB, which a stalling server then sends one byte at a time. */
private val RECORD_HEADER = byteArrayOf(0x16, 0x03, 0x03, 0x40, 0x00)

/**
 * A TCP server on the loopback interface that never finishes a TLS handshake: it reads what the client sends and,
 * when [trickles], keeps it waiting with one byte every 50 ms, so that no read of the client ever times out.
 */
private class StallingServer(private val trickles: Boolean) : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val accepted = CountDownLatch(1)
    private val clientClosed = CountDownLatch(1)
    private var socket: Socket? = null
    val port: Int get() = server.localPort

    init {
        thread(isDaemon = true, name = "stalling-tls") {
            val connection = try {
                server.accept()
            } catch (_: IOException) {
                return@thread
            }
            socket = connection
            accepted.countDown()
            if (trickles) thread(isDaemon = true, name = "stalling-tls-trickle") { trickle(connection) }
            try {
                while (connection.getInputStream().read() != -1) Unit
            } catch (_: IOException) {
                // A reset is the client closing too.
            }
            clientClosed.countDown()
        }
    }

    private fun trickle(connection: Socket) {
        try {
            connection.getOutputStream().apply {
                write(RECORD_HEADER)
                flush()
                while (true) {
                    Thread.sleep(50)
                    write(0)
                    flush()
                }
            }
        } catch (_: IOException) {
            // The client closed the connection.
        }
    }

    fun awaitAccepted() = assertTrue(accepted.await(5, TimeUnit.SECONDS), "the client connected")

    fun awaitClientClosed(): Boolean = clientClosed.await(5, TimeUnit.SECONDS)

    override fun close() {
        server.close()
        socket?.close()
    }
}

/** A TLS socket factory that fails with an error that is not an I/O failure when it layers TLS on a socket. */
private class BrokenFactory : SSLSocketFactory() {
    override fun getDefaultCipherSuites(): Array<String> = emptyArray()

    override fun getSupportedCipherSuites(): Array<String> = emptyArray()

    override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
        throw IllegalStateException("broken factory")

    override fun createSocket(host: String, port: Int): Socket = throw IllegalStateException("broken factory")

    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
        throw IllegalStateException("broken factory")

    override fun createSocket(host: InetAddress, port: Int): Socket = throw IllegalStateException("broken factory")

    override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
        throw IllegalStateException("broken factory")
}

/** A dispatcher that runs what it is given only when the test says so, on the test's thread. */
private class StepDispatcher : CoroutineDispatcher() {
    private val queue = LinkedBlockingQueue<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
        queue.put(block)
    }

    /** The next task, waited for up to five seconds and not run yet. */
    fun next(): Runnable = assertNotNull(queue.poll(5, TimeUnit.SECONDS), "a task was dispatched")

    fun runQueued() {
        while (true) queue.poll()?.run() ?: return
    }
}

class ImapTransportTest {
    private val closing = mutableListOf<AutoCloseable>()

    @AfterTest fun closeServers() = closing.forEach { it.close() }

    private fun stalling(trickles: Boolean) = StallingServer(trickles).also { closing += it }

    private val factory: SSLSocketFactory = SSLContext.getDefault().socketFactory

    @Test
    fun aCancelledConnectClosesTheSocketAtOnce() = runBlocking {
        val server = stalling(trickles = false)
        val connecting = launch(Dispatchers.Default) { openTls(factory, "localhost", server.port) }
        server.awaitAccepted()

        withTimeout(5_000) {
            connecting.cancel()
            connecting.join()
        }

        assertTrue(server.awaitClientClosed(), "the handshake's socket is closed")
    }

    @Test
    fun theConnectAndTheHandshakeTogetherAreBoundedAndTheSocketIsClosed() = runBlocking {
        val server = stalling(trickles = true)

        val failure = withTimeout(5_000) {
            assertFailsWith<ImapException> { openTls(factory, "localhost", server.port, timeoutMillis = 500) }.failure
        }

        assertEquals(ImapFailure.TIMEOUT, failure)
        assertTrue(server.awaitClientClosed(), "the timed out socket is closed")
    }

    @Test
    fun aFailureThatIsNoIoFailureStillClosesTheSocket() = runBlocking {
        val server = stalling(trickles = false)

        assertFailsWith<IllegalStateException> { openTls(BrokenFactory(), "localhost", server.port) }

        assertTrue(server.awaitClientClosed(), "the plain socket is closed")
    }

    @Test
    fun theTlsSocketChecksTheCertificateAgainstTheHostAndOffersOnlyModernTls() {
        // A host name SNI cannot carry (an underscore) is still checked against the certificate, without SNI.
        val cases = listOf("imap.example.com" to listOf(SNIHostName("imap.example.com")), "imap_1.example.com" to null)
        for ((host, serverNames) in cases) {
            val socket = assertIs<SSLSocket>(factory.createSocket())
            val parameters = verifyingHost(socket, host)
            assertEquals("HTTPS", parameters.endpointIdentificationAlgorithm, host)
            assertEquals(serverNames, parameters.serverNames, host)
            assertTrue(parameters.protocols.isNotEmpty(), host)
            assertTrue(parameters.protocols.all { it == "TLSv1.2" || it == "TLSv1.3" }, host)
            socket.close()
        }
    }

    @Test
    fun aSessionCancelledOnceTheSignInFinishedIsClosed() {
        val server = FakeImapServer(greeting = "* PREAUTH welcome back") {}.also { closing += it }
        val source = ImapMailHistorySource(server.transport, ImapTimeouts())
        val caller = StepDispatcher()
        val opening = CoroutineScope(caller).async { source.open(MailHistoryLogin("imap.example.com", "me", "pw")) }

        // The open starts and signs in on another thread; its result comes back as a task of the caller.
        caller.next().run()
        val signedIn = caller.next()
        opening.cancel()
        signedIn.run()
        caller.runQueued()

        assertIs<CancellationException>(opening.getCompletionExceptionOrNull())
        assertTrue(server.awaitClientClosedAll(), "nobody got the session, so it is closed")
    }
}
