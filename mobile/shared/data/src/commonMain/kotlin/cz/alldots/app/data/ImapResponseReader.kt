package cz.alldots.app.data

import kotlinx.coroutines.withTimeoutOrNull

private const val READ_CHUNK_BYTES = 64 * 1024
private const val CR: Byte = 13
private const val LF: Byte = 10
private const val OPEN_BRACE = '{'.code.toByte()
private const val CLOSE_BRACE = '}'.code.toByte()
private const val MAX_LITERAL_DIGITS = 10

/** A literal announcement's `}` and the CRLF after it. */
private const val ANNOUNCEMENT_TAIL = 3

/** A growable byte buffer that refuses to grow past [limit] bytes. */
internal class ByteSink(private val limit: Int) {
    private var bytes = ByteArray(INITIAL_CAPACITY)
    var size = 0
        private set

    fun append(source: ByteArray, from: Int = 0, to: Int = source.size) {
        val count = to - from
        if (count > limit - size) throw ImapException(ImapFailure.PROTOCOL)
        if (size + count > bytes.size) {
            val grown = bytes.copyOf(maxOf(size + count, minOf(bytes.size * 2, limit)))
            // The bytes may be a command with a password in it; no copy of them is left behind.
            bytes.fill(0)
            bytes = grown
        }
        source.copyInto(bytes, size, from, to)
        size += count
    }

    fun append(text: String) {
        val encoded = text.encodeToByteArray()
        append(encoded)
        encoded.fill(0)
    }

    operator fun get(index: Int): Byte = bytes[index]

    fun toByteArray(): ByteArray = bytes.copyOf(size)

    /** The bytes appended so far, which this sink then forgets and zeroes. */
    fun takeBytes(): ByteArray = toByteArray().also {
        bytes.fill(0)
        size = 0
    }

    private companion object {
        const val INITIAL_CAPACITY = 256
    }
}

/**
 * Splits what an IMAP server sends into whole responses: a line up to its CRLF, and when the line ends in a literal
 * announcement `{n}`, the n octets of the literal and the line that follows, until a line ends without one. Each
 * response comes out exactly as the server sent it, literals and the final CRLF included. A response longer than
 * [maxResponseBytes], or a literal that announces more, breaks the protocol; a server silent for [readTimeoutMillis]
 * times out, and one that closes the stream is unreachable.
 */
internal class ImapResponseReader(
    private val stream: ImapByteStream,
    private val maxResponseBytes: Int,
    private val readTimeoutMillis: Long,
) {
    private val buffer = ByteArray(READ_CHUNK_BYTES)
    private var start = 0
    private var end = 0

    /** Where the line being read starts in the response: a literal before it never ends or announces anything. */
    private var lineStart = 0

    suspend fun next(): ByteArray {
        val response = ByteSink(maxResponseBytes)
        appendLine(response)
        var literal = literalLength(response)
        while (literal != null) {
            if (literal > maxResponseBytes - response.size) throw ImapException(ImapFailure.PROTOCOL)
            appendLiteral(response, literal.toInt())
            appendLine(response)
            literal = literalLength(response)
        }
        return response.toByteArray()
    }

    /** Appends up to and including the next CRLF; a bare LF belongs to the line. */
    private suspend fun appendLine(response: ByteSink) {
        lineStart = response.size
        var complete = false
        while (!complete) {
            if (start == end) fill()
            var lf = start
            while (lf < end && buffer[lf] != LF) lf++
            val stop = if (lf < end) lf + 1 else end
            response.append(buffer, start, stop)
            start = stop
            complete = lf < end && response.size - 2 >= lineStart && response[response.size - 2] == CR
        }
    }

    private suspend fun appendLiteral(response: ByteSink, length: Int) {
        var left = length
        while (left > 0) {
            if (start == end) fill()
            val take = minOf(left, end - start)
            response.append(buffer, start, start + take)
            start += take
            left -= take
        }
    }

    /** The length the line just read announces with `{n}` before its CRLF, `null` when it announces none. */
    private fun literalLength(response: ByteSink): Long? {
        val close = response.size - ANNOUNCEMENT_TAIL
        if (close <= lineStart || response[close] != CLOSE_BRACE) return null
        var open = close - 1
        while (open >= lineStart && response[open] in DIGITS) open--
        val digits = close - open - 1
        return if (open >= lineStart && response[open] == OPEN_BRACE && digits in 1..MAX_LITERAL_DIGITS) {
            (open + 1 until close).fold(0L) { value, index -> value * DECIMAL + (response[index] - ZERO) }
        } else {
            null
        }
    }

    private suspend fun fill() {
        val read = withTimeoutOrNull(readTimeoutMillis) { stream.read(buffer) }
            ?: throw ImapException(ImapFailure.TIMEOUT)
        if (read < 0) throw ImapException(ImapFailure.UNREACHABLE)
        start = 0
        end = read
    }

    private companion object {
        const val ZERO = '0'.code.toByte()
        const val DECIMAL = 10L
        val DIGITS = '0'.code.toByte()..'9'.code.toByte()
    }
}
