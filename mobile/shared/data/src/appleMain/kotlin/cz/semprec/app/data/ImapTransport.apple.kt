@file:OptIn(ExperimentalForeignApi::class)

package cz.semprec.app.data

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import platform.Network.NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT
import platform.Network.nw_connection_cancel
import platform.Network.nw_connection_create
import platform.Network.nw_connection_receive
import platform.Network.nw_connection_send
import platform.Network.nw_connection_set_queue
import platform.Network.nw_connection_set_state_changed_handler
import platform.Network.nw_connection_start
import platform.Network.nw_connection_state_cancelled
import platform.Network.nw_connection_state_failed
import platform.Network.nw_connection_state_ready
import platform.Network.nw_connection_state_waiting
import platform.Network.nw_connection_t
import platform.Network.nw_endpoint_create_host
import platform.Network.nw_error_domain_tls
import platform.Network.nw_error_get_error_domain
import platform.Network.nw_error_t
import platform.Network.nw_parameters_create_secure_tcp
import platform.Network.nw_tcp_options_set_connection_timeout
import platform.Network.nw_tls_copy_sec_protocol_options
import platform.Security.sec_protocol_options_set_min_tls_protocol_version
import platform.Security.sec_protocol_options_set_tls_server_name
import platform.Security.tls_protocol_version_TLSv12
import platform.darwin.dispatch_data_apply
import platform.darwin.dispatch_data_create
import platform.darwin.dispatch_data_get_size
import platform.darwin.dispatch_data_t
import platform.darwin.dispatch_queue_create
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val MILLIS_PER_SECOND = 1_000L

/** How the connection's start ended: ready when [failure] is `null`. */
private class Started(val failure: ImapFailure?)

/**
 * Network.framework's TLS over TCP: the system trust evaluation of the server certificate against the endpoint's
 * host name, which is also the server name the handshake sends, and TLS 1.2 at least.
 */
internal actual fun tlsImapTransport(): ImapTransport = ImapTransport { host -> NetworkImapStream.connect(host) }

private class NetworkImapStream(private val connection: nw_connection_t) : ImapByteStream {
    override suspend fun read(buffer: ByteArray): Int {
        val received = suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { nw_connection_cancel(connection) }
            nw_connection_receive(connection, 1u, buffer.size.toUInt()) { content, _, complete, error ->
                when {
                    content != null && dispatch_data_get_size(content) > 0u ->
                        continuation.resume(bytesOf(content))
                    error != null -> continuation.resumeWithException(ImapException(failureOf(error)))
                    complete -> continuation.resume(null)
                    else -> continuation.resume(ByteArray(0))
                }
            }
        }
        return received?.let {
            it.copyInto(buffer)
            it.size
        } ?: -1
    }

    override suspend fun write(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        // A null destructor copies the bytes into the data object.
        val data = bytes.usePinned { dispatch_data_create(it.addressOf(0), bytes.size.toULong(), null, null) }
        suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { nw_connection_cancel(connection) }
            nw_connection_send(connection, data, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true) { error ->
                if (error == null) {
                    continuation.resume(Unit)
                } else {
                    continuation.resumeWithException(ImapException(failureOf(error)))
                }
            }
        }
    }

    override fun close() = nw_connection_cancel(connection)

    companion object {
        suspend fun connect(host: String): NetworkImapStream {
            val parameters = nw_parameters_create_secure_tcp(
                { tls ->
                    val security = nw_tls_copy_sec_protocol_options(tls)
                    sec_protocol_options_set_min_tls_protocol_version(security, tls_protocol_version_TLSv12)
                    sec_protocol_options_set_tls_server_name(security, host)
                },
                { tcp ->
                    val seconds = IMAP_CONNECT_TIMEOUT_MILLIS / MILLIS_PER_SECOND
                    nw_tcp_options_set_connection_timeout(tcp, seconds.toUInt())
                },
            )
            val endpoint = nw_endpoint_create_host(host, IMAP_TLS_PORT.toString())
            val connection = nw_connection_create(endpoint, parameters) ?: throw ImapException(ImapFailure.UNREACHABLE)
            val stream = NetworkImapStream(connection)
            stream.start()
            return stream
        }
    }

    /** Starts the connection and waits until it is ready; a failed or slow start closes it. */
    private suspend fun start() {
        val started = CompletableDeferred<Started>()
        nw_connection_set_state_changed_handler(connection) { state, error ->
            when (state) {
                nw_connection_state_ready -> started.complete(Started(null))
                // Waiting is a connection the system cannot make now (no route, refused, a rejected certificate).
                nw_connection_state_waiting, nw_connection_state_failed ->
                    started.complete(Started(failureOf(error)))
                nw_connection_state_cancelled -> started.complete(Started(ImapFailure.UNREACHABLE))
                else -> Unit
            }
        }
        nw_connection_set_queue(connection, dispatch_queue_create("cz.semprec.imap", null))
        nw_connection_start(connection)
        val outcome = try {
            withTimeoutOrNull(IMAP_CONNECT_TIMEOUT_MILLIS) { started.await() }
        } catch (cancelled: CancellationException) {
            close()
            throw cancelled
        }
        val failure = if (outcome == null) ImapFailure.TIMEOUT else outcome.failure
        if (failure != null) {
            close()
            throw ImapException(failure)
        }
    }
}

private fun failureOf(error: nw_error_t?): ImapFailure =
    if (error != null && nw_error_get_error_domain(error) == nw_error_domain_tls) {
        ImapFailure.TLS_FAILED
    } else {
        ImapFailure.UNREACHABLE
    }

private fun bytesOf(content: dispatch_data_t): ByteArray {
    val bytes = ByteArray(dispatch_data_get_size(content).toInt())
    dispatch_data_apply(content) { _, offset, region, size ->
        region?.reinterpret<ByteVar>()?.readBytes(size.toInt())?.copyInto(bytes, offset.toInt())
        true
    }
    return bytes
}
