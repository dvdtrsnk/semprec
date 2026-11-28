package cz.alldots.app.data

import kotlin.io.encoding.Base64

private const val SPACE = ' '.code
private const val QUOTE = '"'.code
private const val BACKSLASH = '\\'.code
private const val PRINTABLE_FIRST = 0x20
private const val PRINTABLE_LAST = 0x7E
private const val AMPERSAND = '&'

/** A piece of a command: text the client writes as it is, or a literal it announces and sends after `+`. */
internal sealed interface ImapPart {
    class Text(val text: String) : ImapPart

    class Literal(val bytes: ByteArray) : ImapPart
}

/**
 * [value] as an IMAP string: quoted, with `"` and `\` escaped, when it is printable ASCII, else a literal of its UTF-8
 * bytes, so that no byte of a password or a folder name is ever lost or misread.
 */
internal fun imapString(value: String): ImapPart {
    val bytes = value.encodeToByteArray()
    val printable = bytes.all { it.toInt() in PRINTABLE_FIRST..PRINTABLE_LAST }
    return if (printable) {
        val escaped = buildString {
            append('"')
            for (byte in bytes) {
                if (byte.toInt() == QUOTE || byte.toInt() == BACKSLASH) append('\\')
                append(byte.toInt().toChar())
            }
            append('"')
        }
        ImapPart.Text(escaped)
    } else {
        ImapPart.Literal(bytes)
    }
}

private val MODIFIED_BASE64 = Base64.Default.withPadding(Base64.PaddingOption.ABSENT)

/**
 * [name] in IMAP's modified UTF-7 (RFC 3501 5.1.3), as imapflow writes a path to a server without UTF8=ACCEPT:
 * printable ASCII stays, `&` is `&-`, and every run of other characters is `&`, the modified base64 of its UTF-16BE
 * (`,` for `/`, no padding), and `-`.
 */
internal fun modifiedUtf7(name: String): String = buildString {
    var index = 0
    while (index < name.length) {
        val char = name[index]
        when {
            char == AMPERSAND -> {
                append("&-")
                index++
            }
            char.code in PRINTABLE_FIRST..PRINTABLE_LAST -> {
                append(char)
                index++
            }
            else -> {
                var stop = index
                while (stop < name.length && name[stop].code !in PRINTABLE_FIRST..PRINTABLE_LAST) stop++
                val utf16 = ByteArray((stop - index) * 2)
                for (offset in 0 until stop - index) {
                    val code = name[index + offset].code
                    utf16[offset * 2] = (code shr Byte.SIZE_BITS).toByte()
                    utf16[offset * 2 + 1] = code.toByte()
                }
                append('&').append(MODIFIED_BASE64.encode(utf16).replace('/', ',')).append('-')
                index = stop
            }
        }
    }
}

/** How the server completed a command. */
internal enum class ImapStatus { OK, NO, BAD }

/** The atoms of [line] after its first [skip] ones, as ASCII text without the final CRLF. */
internal fun imapWords(line: ByteArray, skip: Int): List<String> =
    line.decodeToString().trimEnd('\r', '\n').split(' ').filter { it.isNotEmpty() }.drop(skip)

/** Whether [response] starts with [prefix], compared without case as IMAP compares its keywords. */
internal fun imapStartsWith(response: ByteArray, prefix: String): Boolean =
    response.size >= prefix.length &&
        prefix.indices.all { response[it].toInt().toChar().equals(prefix[it], ignoreCase = true) }

/** What an untagged FETCH response carries at its top level: its UID and the names of its data items. */
internal class FetchItems(val uid: Long?, val names: Set<String>)

/**
 * The top-level data items of an untagged FETCH response `* <n> FETCH (...)`, `null` for any other response. Values
 * are skipped as IMAP frames them (lists, quoted strings, literals, atoms), so a `UID` inside a header or a body is
 * never taken for the message's. A response that breaks this syntax breaks the protocol.
 */
internal fun fetchItems(response: ByteArray): FetchItems? {
    val prefix = response.copyOf(minOf(response.size, FETCH_PREFIX_BYTES)).decodeToString()
    return if (FETCH_PREFIX.containsMatchIn(prefix)) FetchScanner(response).items() else null
}

private const val FETCH_PREFIX_BYTES = 32
private val FETCH_PREFIX = Regex("^\\* [0-9]+ FETCH \\(", RegexOption.IGNORE_CASE)
private val ATOM_END = setOf(SPACE, '('.code, ')'.code, '\r'.code)

/** Walks one FETCH response; any read past its end or an unexpected byte is a protocol failure. */
private class FetchScanner(private val bytes: ByteArray) {
    private var at = 0

    fun items(): FetchItems {
        // The response starts `* <n> FETCH (`, as [fetchItems] checked.
        at = bytes.indexOf('('.code.toByte()) + 1
        var uid: Long? = null
        val names = mutableSetOf<String>()
        skipSpaces()
        while (byte() != ')'.code) {
            val name = name()
            names += name
            expect(SPACE)
            if (name == "UID") uid = number() else value()
            skipSpaces()
        }
        at++
        expect('\r'.code)
        expect('\n'.code)
        if (at != bytes.size) fail()
        return FetchItems(uid, names)
    }

    /** A data item name, `BODY[HEADER.FIELDS (A B)]<0>` included, in upper case. */
    private fun name(): String {
        val from = at
        var depth = 0
        while (depth > 0 || (byte() != SPACE && byte() != ')'.code)) {
            when (byte()) {
                '['.code -> depth++
                ']'.code -> depth--
            }
            at++
        }
        if (at == from) fail()
        return bytes.copyOfRange(from, at).decodeToString().uppercase()
    }

    private fun number(): Long {
        val from = at
        while (byte() in '0'.code..'9'.code) at++
        return bytes.copyOfRange(from, at).decodeToString().toLongOrNull() ?: fail()
    }

    /** One value: a parenthesized list with everything in it, a quoted string, a literal or an atom. */
    private fun value() {
        var depth = 0
        do {
            when (byte()) {
                '('.code -> {
                    depth++
                    at++
                }
                ')'.code -> {
                    if (depth == 0) fail()
                    depth--
                    at++
                }
                QUOTE -> quoted()
                '{'.code -> literal()
                '~'.code -> if (bytes.getOrNull(at + 1)?.toInt() == '{'.code) literal(at + 1) else at++
                SPACE -> if (depth == 0) fail() else at++
                else -> atom()
            }
        } while (depth > 0)
    }

    private fun atom() {
        val from = at
        while (byte() !in ATOM_END) at++
        if (at == from) fail()
    }

    private fun quoted() {
        at++
        while (byte() != QUOTE) at += if (byte() == BACKSLASH) 2 else 1
        at++
    }

    /** `{n}` CRLF and n octets, the opening brace at [brace]. */
    private fun literal(brace: Int = at) {
        at = brace + 1
        val length = number()
        expect('}'.code)
        expect('\r'.code)
        expect('\n'.code)
        if (length > bytes.size - at) fail()
        at += length.toInt()
    }

    private fun skipSpaces() {
        while (byte() == SPACE) at++
    }

    private fun expect(code: Int) {
        if (byte() != code) fail()
        at++
    }

    private fun byte(): Int = if (at < bytes.size) bytes[at].toInt() else fail()
}
private fun fail(): Nothing = throw ImapException(ImapFailure.PROTOCOL)
