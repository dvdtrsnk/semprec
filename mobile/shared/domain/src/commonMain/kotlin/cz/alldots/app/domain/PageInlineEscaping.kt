package cz.alldots.app.domain

private const val PAGE_LINK_PREFIX = "alldots://page/"
private const val HEX_RADIX = 16
private val LINK_UNSAFE = Regex("[\\s()<>\\\\]")
private val LINK_ESCAPES = Regex("&#xa;|[\\n\\\\<>]")

/** How text, code and link destinations are written so that [PageInlineParser] reads them back unchanged. */
internal object PageInlineEscaping {
    /**
     * Escapes [text], the plain piece at [offset] of [whole]. A `~` is escaped next to another `~`, and at an edge
     * of the piece that a `~~` strikethrough delimiter touches ([strikeBefore], [strikeAfter]), so it never forms one.
     */
    fun escapePlain(
        text: String,
        offset: Int,
        whole: String,
        strikeBefore: Boolean = false,
        strikeAfter: Boolean = false,
    ): String {
        val leading = whole.takeWhile { it != '\n' && it.isWhitespace() }.length
        val trailing = whole.length - whole.takeLastWhile { it != '\n' && it.isWhitespace() }.length
        val strikeEdges = setOfNotNull(0.takeIf { strikeBefore }, text.lastIndex.takeIf { strikeAfter })
        val out = StringBuilder()
        text.forEachIndexed { index, char ->
            val position = offset + index
            val edge = position < leading || position >= trailing
            val reference = char == '&' && PageInlineSyntax.whitespaceReference(whole, position) != null
            val tilde = escapesTilde(whole, position, atStrike = index in strikeEdges)
            when {
                char != '\n' && char.isWhitespace() && edge -> out.append("&#x${char.code.toString(HEX_RADIX)};")
                reference -> out.append("\\&")
                char in "\\*`[]<" || tilde -> out.append('\\').append(char)
                char == '_' -> out.append(if (underscoreInWord(whole, position)) "_" else "\\_")
                else -> out.append(char)
            }
        }
        return out.toString()
    }

    /** Whether the character at [position] of [whole] is a `~` that could form a `~~` delimiter. */
    private fun escapesTilde(whole: String, position: Int, atStrike: Boolean): Boolean = whole[position] == '~' &&
        (atStrike || whole.getOrNull(position - 1) == '~' || whole.getOrNull(position + 1) == '~')

    private fun underscoreInWord(whole: String, position: Int): Boolean =
        PageInlineSyntax.isWordChar(whole.getOrNull(position - 1)) &&
            PageInlineSyntax.isWordChar(whole.getOrNull(position + 1))

    fun codeSpan(text: String): String {
        val longest = Regex("`+").findAll(text).maxOfOrNull { it.value.length } ?: 0
        val fence = "`".repeat(if (longest == 0) 1 else longest + 1)
        val padded = text.startsWith('`') || text.endsWith('`') ||
            (text.isNotBlank() && (text.startsWith(' ') || text.endsWith(' ')))
        val pad = if (padded) " " else ""
        return "$fence$pad$text$pad$fence"
    }

    fun linkDestination(href: String): String {
        val needsBrackets = href.startsWith(PAGE_LINK_PREFIX) || LINK_UNSAFE.containsMatchIn(href)
        return if (needsBrackets) {
            "<" + LINK_ESCAPES.replace(href) {
                when (it.value) {
                    "\n" -> "&#xa;"
                    "&#xa;" -> "\\&#xa;"
                    else -> "\\" + it.value
                }
            } + ">"
        } else {
            href
        }
    }
}
