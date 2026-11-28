package cz.alldots.app.data

/**
 * Why an IMAP conversation failed: the server refused the sign-in, the TLS handshake or the certificate check failed,
 * the server could not be reached or the connection was lost, it did not answer in time, it broke the protocol, or it
 * refused a command ([REFUSED], a tagged `NO`). Neither the server's text nor any credential is ever part of it.
 */
internal enum class ImapFailure { AUTH_REJECTED, TLS_FAILED, UNREACHABLE, TIMEOUT, PROTOCOL, REFUSED }

/** An IMAP conversation that failed; its message names only the [failure]. */
internal class ImapException(val failure: ImapFailure) : Exception("IMAP failure $failure")

/** A connected byte stream to an IMAP server. Every failure is an [ImapException]; cancellation stays cancellation. */
internal interface ImapByteStream {
    /** Reads what arrived into [buffer] and answers the count, `-1` once the server closed the stream. */
    suspend fun read(buffer: ByteArray): Int

    suspend fun write(bytes: ByteArray)

    /** Closes the connection at once; idempotent and never fails. */
    fun close()
}

/** Opens connections to IMAP servers by host name. */
internal fun interface ImapTransport {
    suspend fun connect(host: String): ImapByteStream
}

/**
 * The only port the client uses: implicit TLS (IMAPS). A server that offers IMAP only with STARTTLS on 143 is not
 * read from the device; its history is the server's to backfill.
 */
internal const val IMAP_TLS_PORT = 993

/** The TCP connect and the TLS handshake together. */
internal const val IMAP_CONNECT_TIMEOUT_MILLIS = 30_000L

/**
 * Implicit TLS to [IMAP_TLS_PORT] with the platform's trust store, the server certificate checked against the host
 * name, TLS 1.2 at least, and a connect bounded by [IMAP_CONNECT_TIMEOUT_MILLIS]: Network.framework on Apple,
 * `javax.net.ssl` on the JVM and Android. A read is cancellable, which is how the client bounds it.
 */
internal expect fun tlsImapTransport(): ImapTransport
