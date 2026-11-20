package cz.semprec.app.domain

private const val ENCODE_RADIX = 16
private const val ENCODE_WIDTH = 4
private val LIST_TYPES = setOf(PageBlockType.BULLET, PageBlockType.NUMBER, PageBlockType.TODO)
private val HEADING_TYPES = setOf(PageBlockType.H1, PageBlockType.H2, PageBlockType.H3)
private val ENCODE_SAFE = Regex("[A-Za-z0-9._:~-]")
private val NUMBER_START = Regex("^(\\d+)\\.(?: |$)")
private val LIST_START = Regex("^[-+](?: |$)")

/** The lines the canonical Markdown has for one block, for a block the person edited or added. */
object PageMarkdownWriter {
    fun isList(type: PageBlockType): Boolean = type in LIST_TYPES

    /** Whether [type] is a heading, the only type that can be a toggle heading ([PageBlock.toggle]). */
    fun isHeading(type: PageBlockType): Boolean = type in HEADING_TYPES

    /** The content line of [block], without a comment line. Empty for an empty text block. */
    fun contentLine(block: PageBlock): String {
        val content = PageInlineWriter.serialize(block.runs)
        val indentPrefix = if (isList(block.type)) "  ".repeat(block.indent) else ""
        return when (block.type) {
            PageBlockType.PAGE -> "[$content](semprec://page/${block.pageId.orEmpty()})"
            PageBlockType.H1 -> withMarker("#", content)
            PageBlockType.H2 -> withMarker("##", content)
            PageBlockType.H3 -> withMarker("###", content)
            PageBlockType.BULLET -> indentPrefix + withMarker("-", content)
            PageBlockType.NUMBER -> indentPrefix + withMarker("1.", content)
            PageBlockType.TODO -> indentPrefix + withMarker(if (block.done) "- [x]" else "- [ ]", content)
            PageBlockType.QUOTE -> withMarker(">", content)
            PageBlockType.TEXT, PageBlockType.TOGGLE -> escapeLineStart(content)
        }
    }

    /**
     * Whether a block must carry a `semprec:block` comment for its content line to read back as it is. A toggle and
     * a toggle heading always do: their content line alone reads as text and as a plain heading.
     */
    fun needsComment(block: PageBlock, line: String): Boolean =
        block.preservedType != null ||
            block.type == PageBlockType.TOGGLE ||
            isToggleHeading(block) ||
            (!isList(block.type) && block.indent != 0) ||
            (line.isEmpty() && block.type != PageBlockType.PAGE)

    /** The comment for a block that has none. It carries no id: the server gives the block one. */
    fun commentLine(block: PageBlock): String {
        val typeKey = block.preservedType?.let { if (it.isEmpty()) "\"\"" else encodeField(it) }
            ?: block.type.name.lowercase()
        val toggle = if (isToggleHeading(block)) " toggle=true" else ""
        return "<!-- semprec:block type=$typeKey indent=${block.indent}$toggle -->"
    }

    private fun isToggleHeading(block: PageBlock): Boolean = block.toggle && isHeading(block.type)

    /** All lines of a new block: its comment when it needs one, then its content line. */
    fun blockLines(block: PageBlock): List<String> {
        val line = contentLine(block)
        return listOfNotNull(commentLine(block).takeIf { needsComment(block, line) }, line.takeIf { it.isNotEmpty() })
    }

    private fun withMarker(marker: String, content: String): String =
        if (content.isEmpty()) marker else "$marker $content"

    private fun escapeLineStart(content: String): String = when {
        content.startsWith("#") || content.startsWith(">") -> "\\$content"
        LIST_START.containsMatchIn(content) -> "\\$content"
        else -> NUMBER_START.find(content)?.let {
            val digits = it.groupValues[1]
            "$digits\\." + content.substring(digits.length + 1)
        } ?: content
    }

    private fun encodeField(value: String): String = value.map {
        if (ENCODE_SAFE.matches(it.toString())) {
            it.toString()
        } else {
            "\\u" + it.code.toString(ENCODE_RADIX).uppercase().padStart(ENCODE_WIDTH, '0')
        }
    }.joinToString("")
}
