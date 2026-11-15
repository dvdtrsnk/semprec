package cz.semprec.app.domain

private const val PAGE_LINK_PREFIX = "semprec://page/"
private const val HEX_RADIX = 16
private val LINK_UNSAFE = Regex("[\\s()<>\\\\]")
private val LINK_ESCAPES = Regex("&#xa;|[\\n\\\\<>]")

/** How text, code and link destinations are written so that [PageInlineParser] reads them back unchanged. */
internal object PageInlineEscaping {
    fun escapePlain(text: String, offset: Int, whole: String): String {
        val leading = whole.takeWhile { it != '\n' && it.isWhitespace() }.length
        val trailing = whole.length - whole.takeLastWhile { it != '\n' && it.isWhitespace() }.length
        val out = StringBuilder()
        text.forEachIndexed { index, char ->
            val position = offset + index
            val edge = position < leading || position >= trailing
            val reference = char == '&' && PageInlineSyntax.whitespaceReference(whole, position) != null
            when {
                char != '\n' && char.isWhitespace() && edge -> out.append("&#x${char.code.toString(HEX_RADIX)};")
                reference -> out.append("\\&")
                char in "\\*`[]<" -> out.append('\\').append(char)
                char == '_' -> out.append(if (underscoreInWord(whole, position)) "_" else "\\_")
                else -> out.append(char)
            }
        }
        return out.toString()
    }

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
