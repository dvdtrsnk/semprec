package cz.alldots.app.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** The TLS versions the client offers; anything older is refused. */
private val TLS_PROTOCOLS = setOf("TLSv1.2", "TLSv1.3")

internal actual fun tlsImapTransport(): ImapTransport = ImapTransport { host ->
    SocketImapStream(openTls(SSLContext.getDefault().socketFactory, host))
}

/**
 * A TCP connection to [host] on [port] with TLS on top, its handshake done: the platform's trust store, the
 * certificate checked against [host] (`HTTPS` endpoint identification), [host] as the server name. The connect and
 * the handshake together take at most [timeoutMillis]. Whenever the caller does not get the socket (a failure, the
 * timeout, a cancellation, also one that arrives after the handshake finished) the socket is closed.
 */
internal suspend fun openTls(
    factory: SSLSocketFactory,
    host: String,
    port: Int = IMAP_TLS_PORT,
    timeoutMillis: Long = IMAP_CONNECT_TIMEOUT_MILLIS,
): SSLSocket {
    val plain = Socket()
    var opened: SSLSocket? = null
    try {
        val tls = withTimeoutOrNull(timeoutMillis) {
            blockingOn(plain) {
                plain.connect(InetSocketAddress(host, port), timeoutMillis.toInt())
                val tls = factory.createSocket(plain, host, port, true) as? SSLSocket
                    ?: throw SSLException("The TLS socket factory made no TLS socket")
                tls.sslParameters = verifyingHost(tls, host)
                // Closing the socket ends a blocked handshake; the read timeout is a second bound behind it.
                tls.soTimeout = timeoutMillis.toInt()
                tls.startHandshake()
                tls.soTimeout = 0
                tls
            }
        } ?: throw ImapException(ImapFailure.TIMEOUT)
        opened = tls
        return tls
    } finally {
        if (opened == null) closeQuietly(plain)
    }
}

/**
 * The socket's parameters with the certificate checked against [host], only [TLS_PROTOCOLS], and [host] as SNI when
 * it is a name SNI can carry (one with an underscore is not); otherwise the handshake sends no server name.
 */
internal fun verifyingHost(socket: SSLSocket, host: String) = socket.sslParameters.apply {
    endpointIdentificationAlgorithm = "HTTPS"
    sniHostName(host)?.let { serverNames = listOf(it) }
    protocols = protocols.filter { it in TLS_PROTOCOLS }.toTypedArray()
}

private fun sniHostName(host: String): SNIHostName? = try {
    SNIHostName(host)
} catch (_: IllegalArgumentException) {
    null
}

private fun transportFailure(failed: IOException): ImapFailure = when (failed) {
    is SSLException -> ImapFailure.TLS_FAILED
    is SocketTimeoutException -> ImapFailure.TIMEOUT
    else -> ImapFailure.UNREACHABLE
}

private fun closeQuietly(socket: Socket) {
    try {
        socket.close()
    } catch (_: IOException) {
        // Closing a socket that failed has nothing left to report.
    }
}

/**
 * Runs the blocking [call] on [socket] on the IO dispatcher. A caller that is cancelled meanwhile closes the socket,
 * the only way to end a blocked call, so the client's timeouts hold; the failure the closed socket then raises is
 * that cancellation. Any other I/O failure is an [ImapException].
 */
private suspend fun <T> blockingOn(socket: Socket, call: () -> T): T = coroutineScope {
    val finished = AtomicBoolean(false)
    val closer = launch(start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } catch (cancelled: CancellationException) {
            if (!finished.get()) closeQuietly(socket)
            throw cancelled
        }
    }
    try {
        withContext(Dispatchers.IO) {
            try {
                call()
            } catch (failed: IOException) {
                ensureActive()
                throw ImapException(transportFailure(failed))
            }
        }
    } finally {
        finished.set(true)
        closer.cancel()
    }
}

/**
 * The byte stream of a connected [socket], which has no read timeout of its own: the client bounds every read and
 * cancels it, and a cancelled read closes the socket.
 */
internal class SocketImapStream(private val socket: Socket) : ImapByteStream {
    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()

    override suspend fun read(buffer: ByteArray): Int = blockingOn(socket) { input.read(buffer) }

    override suspend fun write(bytes: ByteArray) = blockingOn(socket) {
        output.write(bytes)
        output.flush()
    }

    override fun close() = closeQuietly(socket)
}
