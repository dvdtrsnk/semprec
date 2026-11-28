package cz.alldots.app.domain

private const val HEX_RADIX = 16
private const val MAX_BMP_CODE_POINT = 0xFFFF
private val REFERENCE_PATTERN = Regex("&#x([1-9a-f][0-9a-f]*);")
private val SCHEME_PATTERN = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)

/** The lexical helpers of the inline Markdown of a page, shared by [PageInlineParser] and [PageInlineWriter]. */
internal object PageInlineSyntax {
    /** A character reference of whitespace (`&#x20;`) the serializer writes at the edges of a block's text. */
    fun whitespaceReference(source: String, index: Int): Pair<Char, Int>? {
        val match = REFERENCE_PATTERN.matchAt(source, index) ?: return null
        val point = match.groupValues[1].toIntOrNull(HEX_RADIX)
        val char = if (point != null && point <= MAX_BMP_CODE_POINT) point.toChar() else null
        return if (char != null && char != '\n' && char.isWhitespace()) char to match.value.length else null
    }

    fun isWordChar(char: Char?): Boolean = char != null && char.isLetterOrDigit()

    fun isSpace(char: Char?): Boolean = char == null || char.isWhitespace()

    fun withScheme(href: String): String =
        if (SCHEME_PATTERN.containsMatchIn(href)) href else "https://" + href.removePrefix("//")

    fun fenceLength(source: String, index: Int): Int {
        var length = 0
        while (source.getOrNull(index + length) == '`') length += 1
        return length
    }

    /** The end (exclusive) of the code span that opens at [index], or -1 when its fence never closes. */
    fun codeSpanEnd(source: String, index: Int): Int {
        val length = fenceLength(source, index)
        var cursor = index + length
        var end = -1
        while (end == -1 && cursor < source.length) {
            if (source[cursor] == '`') {
                val close = fenceLength(source, cursor)
                if (close == length) end = cursor + close else cursor += close
            } else {
                cursor += 1
            }
        }
        return end
    }

    /** Where scanning continues after a code span or an unclosed fence that starts at [cursor]. */
    private fun skipCode(source: String, cursor: Int): Int {
        val end = codeSpanEnd(source, cursor)
        return if (end == -1) cursor + fenceLength(source, cursor) else end
    }

    /** The next unescaped [token] at or after [from] that is outside code spans and that [accept] allows. */
    fun findDelimiter(source: String, from: Int, token: String, accept: (Int) -> Boolean): Int {
        var cursor = from
        var found = -1
        while (found == -1 && cursor < source.length) {
            cursor = when {
                source[cursor] == '\\' -> cursor + 2
                source[cursor] == '`' -> skipCode(source, cursor)
                source.startsWith(token, cursor) && accept(cursor) -> {
                    found = cursor
                    cursor
                }
                else -> cursor + 1
            }
        }
        return found
    }

    /** The index of the `]` that closes the `[` at [openIndex], or -1. */
    fun findLinkTextEnd(source: String, openIndex: Int): Int {
        var depth = 0
        var cursor = openIndex
        var end = -1
        while (end == -1 && cursor < source.length) {
            val char = source[cursor]
            depth += if (char == '[') 1 else if (char == ']') -1 else 0
            if (char == ']' && depth == 0) end = cursor
            cursor = when (char) {
                '\\' -> cursor + 2
                '`' -> skipCode(source, cursor)
                else -> cursor + 1
            }
        }
        return end
    }
}

internal fun isAsciiPunctuation(char: Char): Boolean =
    char in '!'..'/' || char in ':'..'@' || char in '['..'`' || char in '{'..'~'
