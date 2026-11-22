package cz.semprec.app.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
    withContext(Dispatchers.IO) { SocketImapStream(openTls(SSLContext.getDefault().socketFactory, host)) }
}

/**
 * A TCP connection to [host] on [IMAP_TLS_PORT] with TLS on top, its handshake done: the platform's trust store,
 * the certificate checked against [host] (`HTTPS` endpoint identification), [host] as the server name.
 */
private fun openTls(factory: SSLSocketFactory, host: String): SSLSocket {
    val plain = Socket()
    return try {
        plain.connect(InetSocketAddress(host, IMAP_TLS_PORT), IMAP_CONNECT_TIMEOUT_MILLIS.toInt())
        val tls = factory.createSocket(plain, host, IMAP_TLS_PORT, true) as? SSLSocket
            ?: throw SSLException("The TLS socket factory made no TLS socket")
        tls.sslParameters = verifyingHost(tls, host)
        tls.soTimeout = IMAP_CONNECT_TIMEOUT_MILLIS.toInt()
        tls.startHandshake()
        // Reads are bounded by the client, which cancels them; a cancelled read closes the socket.
        tls.soTimeout = 0
        tls
    } catch (failed: IOException) {
        closeQuietly(plain)
        throw ImapException(transportFailure(failed))
    }
}

/** The socket's parameters with the certificate checked against [host], [host] as SNI and only [TLS_PROTOCOLS]. */
internal fun verifyingHost(socket: SSLSocket, host: String) = socket.sslParameters.apply {
    endpointIdentificationAlgorithm = "HTTPS"
    serverNames = listOf(SNIHostName(host))
    protocols = protocols.filter { it in TLS_PROTOCOLS }.toTypedArray()
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
 * The byte stream of a connected [socket]. Its blocking reads and writes run on the IO dispatcher; a caller that is
 * cancelled meanwhile closes the socket, the only way to end a blocked call, so the client's timeouts hold.
 */
internal class SocketImapStream(private val socket: Socket) : ImapByteStream {
    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()

    override suspend fun read(buffer: ByteArray): Int = blocking { input.read(buffer) }

    override suspend fun write(bytes: ByteArray) = blocking {
        output.write(bytes)
        output.flush()
    }

    override fun close() = closeQuietly(socket)

    private suspend fun <T> blocking(call: () -> T): T = coroutineScope {
        val finished = AtomicBoolean(false)
        val closer = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } catch (cancelled: CancellationException) {
                if (!finished.get()) close()
                throw cancelled
            }
        }
        try {
            withContext(Dispatchers.IO) {
                try {
                    call()
                } catch (failed: IOException) {
                    // A socket the cancelled caller closed fails here; that is the cancellation, not a failure.
                    ensureActive()
                    throw ImapException(transportFailure(failed))
                }
            }
        } finally {
            finished.set(true)
            closer.cancel()
        }
    }
}
