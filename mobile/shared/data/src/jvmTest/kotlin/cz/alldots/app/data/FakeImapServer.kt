package cz.alldots.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** One command as the client sent it: its tag and what follows, each literal inline as its bytes. */
internal class ImapCommand(val tag: String, val bytes: ByteArray) {
    /** The command after its tag, without the final CRLF. */
    val text: String get() = bytes.decodeToString().removePrefix("$tag ").removeSuffix("\r\n")
}

/** What the fake server writes back on one connection, and the client line it can wait for. */
internal class ImapReply(private val input: InputStream, private val output: OutputStream, private val chunk: Int) {
    fun line(text: String) = bytes("$text\r\n".encodeToByteArray())

    /** Writes [bytes] in pieces of the server's chunk size, each flushed, so that they arrive in several reads. */
    fun bytes(bytes: ByteArray) {
        bytes.asList().chunked(chunk).forEach {
            output.write(it.toByteArray())
            output.flush()
        }
    }

    fun ok(command: ImapCommand, text: String = "done") = line("${command.tag} OK $text")

    /** The next line the client sends outside a command, as the answer to a `+` challenge. */
    fun readClientLine(): String = readLine(input).decodeToString().removeSuffix("\r\n")
}

/**
 * An IMAP server on the loopback interface over plain TCP, behind the production [SocketImapStream]: it sends
 * [greeting] (nothing when `null`), answers each literal the client announces with `+`, records every command and
 * lets [handler] answer it. Responses go out in pieces of [chunk] bytes.
 */
internal class FakeImapServer(
    private val greeting: String? = "* OK fake IMAP ready",
    private val chunk: Int = Int.MAX_VALUE,
    private val handler: ImapReply.(ImapCommand) -> Unit,
) : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val sockets = CopyOnWriteArrayList<Socket>()
    val commands = CopyOnWriteArrayList<ImapCommand>()

    /** Connects to this server whatever the host name. */
    val transport = ImapTransport { _ ->
        withContext(Dispatchers.IO) { SocketImapStream(Socket(InetAddress.getLoopbackAddress(), server.localPort)) }
    }

    init {
        thread(isDaemon = true, name = "fake-imap") {
            try {
                while (true) {
                    val socket = server.accept()
                    sockets += socket
                    thread(isDaemon = true, name = "fake-imap-connection") { converse(socket) }
                }
            } catch (_: IOException) {
                // The server socket was closed: the test is over.
            }
        }
    }

    val connections: Int get() = sockets.size

    private val ended = AtomicInteger()

    /** Waits until the client closed every connection it opened, up to [millis]; whether it did. */
    fun awaitClientClosedAll(millis: Long = 5_000L): Boolean {
        val deadline = System.currentTimeMillis() + millis
        while (ended.get() < sockets.size && System.currentTimeMillis() < deadline) Thread.sleep(10)
        return ended.get() == sockets.size
    }

    private fun converse(socket: Socket) {
        val input = socket.getInputStream()
        val output = socket.getOutputStream()
        val reply = ImapReply(input, output, chunk)
        try {
            greeting?.let { reply.line(it) }
            while (true) {
                val command = readCommand(input, output)
                commands += command
                reply.handler(command)
            }
        } catch (_: IOException) {
            // The client closed the connection (ClientGone), or the test closed the server.
        }
        ended.incrementAndGet()
    }

    private fun readCommand(input: InputStream, output: OutputStream): ImapCommand {
        val command = ByteArrayOutputStream()
        var line = readLine(input)
        command.write(line)
        var literal = LITERAL.find(line.decodeToString())
        while (literal != null) {
            output.write("+ go ahead\r\n".encodeToByteArray())
            output.flush()
            command.write(input.readNBytes(literal.groupValues[1].toInt()))
            line = readLine(input)
            command.write(line)
            literal = LITERAL.find(line.decodeToString())
        }
        val bytes = command.toByteArray()
        return ImapCommand(bytes.decodeToString().substringBefore(' '), bytes)
    }

    override fun close() {
        server.close()
        sockets.forEach { it.close() }
    }

    private companion object {
        val LITERAL = Regex("\\{([0-9]+)}\r\n$")
    }
}

/** The client closed the connection while the server read. */
private class ClientGone : IOException()

private fun readLine(input: InputStream): ByteArray {
    val line = ByteArrayOutputStream()
    var previous = -1
    while (true) {
        val next = input.read()
        if (next == -1) throw ClientGone()
        line.write(next)
        if (previous == '\r'.code && next == '\n'.code) return line.toByteArray()
        previous = next
    }
}

/**
 * An untagged FETCH response as a server sends it for [MAIL_HISTORY_FETCH_ITEMS], the header fields and the text as
 * literals counted in bytes.
 */
internal fun fetchResponse(
    sequence: Int,
    uid: Long,
    text: ByteArray = "Hello there".encodeToByteArray(),
    header: String = "References: <a@example.com>\r\n\r\n",
): ByteArray {
    val headerBytes = header.encodeToByteArray()
    val out = ByteArrayOutputStream()
    out.write(
        (
            "* $sequence FETCH (UID $uid FLAGS (\\Seen) ENVELOPE (\"Mon, 1 Jan 2024 10:00:00 +0000\" \"Hi (there)\" " +
                "((\"Ann\" NIL \"ann\" \"example.com\")) NIL NIL NIL NIL NIL NIL \"<m$uid@example.com>\") " +
                "BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"8BIT\" ${text.size} 1 " +
                "NIL NIL NIL NIL) " +
                "BODY[HEADER.FIELDS (REFERENCES DELIVERED-TO X-ORIGINAL-TO ENVELOPE-TO LIST-UNSUBSCRIBE LIST-ID " +
                "PRECEDENCE AUTO-SUBMITTED)] {${headerBytes.size}}\r\n"
            ).encodeToByteArray(),
    )
    out.write(headerBytes)
    out.write(" BODY[TEXT]<0> {${text.size}}\r\n".encodeToByteArray())
    out.write(text)
    out.write(")\r\n".encodeToByteArray())
    return out.toByteArray()
}
