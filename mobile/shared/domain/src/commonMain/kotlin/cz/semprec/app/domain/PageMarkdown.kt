package cz.semprec.app.domain

private const val MAX_INDENT = 5
private const val INDENT_WIDTH = 2
private const val UTF16_ESCAPE_RADIX = 16
private val COMMENT_PATTERN = Regex("^<!-- semprec:block (.*) -->$")
private val COMMENT_FIELD = Regex("(\\w+)=(\\S+)")
private val COMMENT_TYPE = Regex("^(?:[A-Za-z0-9._:~-]|\\\\u[0-9A-F]{4})+$")
private val UTF16_ESCAPE = Regex("\\\\u([0-9A-F]{4})")
private val PAGE_LINE = Regex("^\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(semprec://page/([^)\\s]+)\\)$")
private val HEADING_LINE = Regex("^(#{1,3})(?: +([\\s\\S]*))?$")
private val TODO_LINE = Regex("^[-*] \\[([ xX])\\](?: +([\\s\\S]*))?$")
private val BULLET_LINE = Regex("^[-*](?: +([\\s\\S]*))?$")
private val NUMBER_LINE = Regex("^\\d+\\.(?: +([\\s\\S]*))?$")
private val QUOTE_LINE = Regex("^> ?([\\s\\S]*)$")

/** What one `semprec:block` comment says; only the fields the comment carries are set. */
private data class CommentFields(val type: String? = null, val indent: Int? = null, val toggle: Boolean = false)

/** What one content line says before a pending comment is applied. */
private data class LineParse(
    val type: PageBlockType,
    val listIndent: Int?,
    val done: Boolean = false,
    val runs: List<InlineRun> = emptyList(),
    val pageId: String? = null,
)

/**
 * The canonical Markdown of a page (docs/adr/2026-11-01-canonical-block-markdown-*.md) read into [PageBlock]s.
 * One non-empty line is one block, and a `semprec:block` comment line applies to the line after it: its `type=toggle`
 * makes a plain line a toggle, and its `toggle=true` makes a heading a toggle heading. This is a
 * port of `parseMarkdown` of `shared/block-model`, without block ids: the page API addresses a block by its place.
 */
object PageMarkdown {
    fun parse(markdown: String): List<PageBlock> {
        val blocks = mutableListOf<PageBlock>()
        var pending: Pair<CommentFields, Int>? = null
        markdown.split("\n").forEachIndexed { index, rawLine ->
            val line = rawLine.removeSuffix("\r")
            val trimmed = line.trim()
            val comment = COMMENT_PATTERN.matchEntire(trimmed)
            val before = pending
            if (trimmed.isEmpty() || comment != null) before?.let { blocks += emptyBlock(it.first, it.second) }
            pending = when {
                trimmed.isEmpty() -> null
                comment != null -> parseComment(comment.groupValues[1]) to index
                else -> {
                    blocks += contentBlock(line, before?.first, before?.second ?: index, index)
                    null
                }
            }
        }
        pending?.let { blocks += emptyBlock(it.first, it.second) }
        return blocks
    }

    private fun emptyBlock(fields: CommentFields, line: Int): PageBlock {
        val known = fields.type?.let(::blockTypeOf)
        val type = if (known != null && known != PageBlockType.PAGE) known else PageBlockType.TEXT
        val preserved = fields.type?.takeIf { known == null }
        return PageBlock(
            type = type,
            indent = fields.indent ?: 0,
            done = false,
            runs = emptyList(),
            pageId = null,
            firstLine = line,
            lastLine = line,
            hasComment = true,
            preservedType = preserved,
            toggle = fields.toggle && PageMarkdownWriter.isHeading(type),
        )
    }

    private fun contentBlock(line: String, comment: CommentFields?, firstLine: Int, lastLine: Int): PageBlock {
        val parsed = parseLine(line)
        val preserved = comment?.type?.takeIf { parsed.type == PageBlockType.TEXT && blockTypeOf(it) == null }
        val toggle = parsed.type == PageBlockType.TEXT && comment?.type?.let(::blockTypeOf) == PageBlockType.TOGGLE
        val type = if (toggle) PageBlockType.TOGGLE else parsed.type
        return PageBlock(
            type = type,
            indent = parsed.listIndent ?: comment?.indent ?: 0,
            done = parsed.done,
            runs = parsed.runs,
            pageId = parsed.pageId,
            firstLine = firstLine,
            lastLine = lastLine,
            hasComment = comment != null,
            preservedType = preserved,
            toggle = comment?.toggle == true && PageMarkdownWriter.isHeading(type),
        )
    }

    private fun parseLine(raw: String): LineParse {
        val spaces = raw.takeWhile { it == ' ' }.length
        val line = raw.trim()
        val listIndent = (spaces / INDENT_WIDTH).coerceIn(0, MAX_INDENT)
        val page = PAGE_LINE.matchEntire(line)
        val heading = HEADING_LINE.matchEntire(line)
        val todo = TODO_LINE.matchEntire(line)
        val bullet = BULLET_LINE.matchEntire(line)
        val number = NUMBER_LINE.matchEntire(line)
        val quote = QUOTE_LINE.matchEntire(line)
        return when {
            page != null -> LineParse(
                PageBlockType.PAGE,
                null,
                runs = PageInlineParser.parse(page.groupValues[1]),
                pageId = decodeUtf16Escapes(page.groupValues[2]),
            )
            heading != null -> LineParse(
                headingType(heading.groupValues[1].length),
                null,
                runs = PageInlineParser.parse(heading.groupValues[2]),
            )
            todo != null -> LineParse(
                PageBlockType.TODO,
                listIndent,
                done = todo.groupValues[1] != " ",
                runs = PageInlineParser.parse(todo.groupValues[2]),
            )
            bullet != null ->
                LineParse(PageBlockType.BULLET, listIndent, runs = PageInlineParser.parse(bullet.groupValues[1]))
            number != null ->
                LineParse(PageBlockType.NUMBER, listIndent, runs = PageInlineParser.parse(number.groupValues[1]))
            quote != null ->
                LineParse(PageBlockType.QUOTE, null, runs = PageInlineParser.parse(quote.groupValues[1].trim()))
            else -> LineParse(PageBlockType.TEXT, null, runs = PageInlineParser.parse(line))
        }
    }

    private fun headingType(level: Int): PageBlockType = when (level) {
        1 -> PageBlockType.H1
        2 -> PageBlockType.H2
        else -> PageBlockType.H3
    }

    private fun parseComment(body: String): CommentFields {
        var type: String? = null
        var indent: Int? = null
        var toggle = false
        for (field in COMMENT_FIELD.findAll(body)) {
            val (key, value) = field.destructured
            if (key == "type" && (value == "\"\"" || COMMENT_TYPE.matches(value))) {
                type = if (value == "\"\"") "" else decodeUtf16Escapes(value)
            }
            if (key == "indent" && value.all { it in '0'..'9' }) {
                indent = (value.toIntOrNull() ?: MAX_INDENT).coerceIn(0, MAX_INDENT)
            }
            if (key == "toggle" && value == "true") toggle = true
        }
        return CommentFields(type, indent, toggle)
    }

    private fun decodeUtf16Escapes(encoded: String): String =
        UTF16_ESCAPE.replace(encoded) { it.groupValues[1].toInt(UTF16_ESCAPE_RADIX).toChar().toString() }

    internal fun blockTypeOf(key: String): PageBlockType? = when (key) {
        "text" -> PageBlockType.TEXT
        "h1" -> PageBlockType.H1
        "h2" -> PageBlockType.H2
        "h3" -> PageBlockType.H3
        "bullet" -> PageBlockType.BULLET
        "number" -> PageBlockType.NUMBER
        "todo" -> PageBlockType.TODO
        "quote" -> PageBlockType.QUOTE
        "page" -> PageBlockType.PAGE
        "toggle" -> PageBlockType.TOGGLE
        else -> null
    }
}
