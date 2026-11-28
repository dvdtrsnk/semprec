package cz.alldots.app.domain

private const val ENTITY_LINE_FEED = "&#xa;"

/** Reads the destination of an inline link, `(https://example.com)` or the bracketed `(<...>)` form. */
internal object PageLinkDestination {
    /** Reads `(destination)` at [index]: the destination and the index after the closing parenthesis. */
    fun parse(source: String, index: Int): Pair<String, Int>? {
        if (source.getOrNull(index) != '(') return null
        val bracketed = source.getOrNull(index + 1) == '<'
        val read = if (bracketed) readBracketed(source, index + 2) else readBare(source, index + 1)
        val closes = read != null && source.getOrNull(read.second) == ')' && read.first.isNotEmpty()
        return if (closes && read != null) read.first to read.second + 1 else null
    }

    private fun readBracketed(source: String, start: Int): Pair<String, Int>? {
        val href = StringBuilder()
        var cursor = start
        while (cursor < source.length && source[cursor] != '>') {
            val escaped = source[cursor] == '\\' && cursor + 1 < source.length
            val lineFeed = source.startsWith(ENTITY_LINE_FEED, cursor)
            href.append(
                when {
                    escaped -> source[cursor + 1]
                    lineFeed -> '\n'
                    else -> source[cursor]
                },
            )
            cursor += if (escaped) 2 else if (lineFeed) ENTITY_LINE_FEED.length else 1
        }
        return if (source.getOrNull(cursor) == '>') href.toString() to cursor + 1 else null
    }

    private fun readBare(source: String, start: Int): Pair<String, Int> {
        var cursor = start
        while (cursor < source.length && !source[cursor].isWhitespace() && source[cursor] != ')') cursor += 1
        return source.substring(start, cursor) to cursor
    }
}
