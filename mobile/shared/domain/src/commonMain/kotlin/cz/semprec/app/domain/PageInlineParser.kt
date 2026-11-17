package cz.semprec.app.domain

private const val BOLD_TOKEN = "**"
private const val CODE_BREAK_TAG = "<code><br></code>"
private val TAG_PATTERN = Regex("<(/?)(strong|b|em|i)>", RegexOption.IGNORE_CASE)
private val BREAK_PATTERN = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)

/**
 * Reads the inline part of the canonical page Markdown (a deliberate subset, not CommonMark) into typed runs, the
 * same way `shared/block-model/src/markdown.ts` does: emphasis, code, links, soft breaks and the escapes the
 * serializer writes. Screens render the runs; they never see the syntax.
 */
object PageInlineParser {
    fun parse(source: String): List<InlineRun> {
        val raw = mutableListOf<InlineRun>()
        InlineScanner(source, bold = false, italic = false, href = null, runs = raw).scan()
        val merged = mutableListOf<InlineRun>()
        for (run in raw) {
            val last = merged.lastOrNull()
            if (last != null && last.sameFormat(run)) {
                merged[merged.lastIndex] = last.copy(text = last.text + run.text)
            } else if (run.text.isNotEmpty()) {
                merged += run
            }
        }
        return merged
    }
}

private fun InlineRun.sameFormat(other: InlineRun): Boolean =
    bold == other.bold && italic == other.italic && code == other.code && link == other.link

private class InlineScanner(
    private val source: String,
    private var bold: Boolean,
    private var italic: Boolean,
    private val href: String?,
    private val runs: MutableList<InlineRun>,
) {
    private val at: (Int) -> Char? = source::getOrNull
    private var pos = 0
    private val buffer = StringBuilder()

    fun scan() {
        val steps = listOf(
            ::escape, ::code, ::angle, ::link, ::strong, ::emphasisStar, ::emphasisUnderscore,
        )
        while (pos < source.length) {
            if (!steps.any { it() }) {
                buffer.append(source[pos])
                pos += 1
            }
        }
        flush()
    }

    private fun flush() {
        if (buffer.isNotEmpty()) runs += InlineRun(buffer.toString(), bold, italic, code = false, link = href)
        buffer.clear()
    }

    private fun addCode(text: String) {
        flush()
        runs += InlineRun(text, bold, italic, code = true, link = href)
    }

    /** A backslash escape of punctuation, or a character reference of whitespace. */
    private fun escape(): Boolean {
        val next = at(pos + 1)
        val reference = if (source[pos] == '&') PageInlineSyntax.whitespaceReference(source, pos) else null
        val escaped = source[pos] == '\\' && next != null && isAsciiPunctuation(next)
        if (escaped && next != null) {
            buffer.append(next)
            pos += 2
        } else if (reference != null) {
            buffer.append(reference.first)
            pos += reference.second
        }
        return escaped || reference != null
    }

    private fun code(): Boolean {
        if (source[pos] != '`') return false
        val length = PageInlineSyntax.fenceLength(source, pos)
        val end = PageInlineSyntax.codeSpanEnd(source, pos)
        if (end == -1) {
            buffer.append(source.substring(pos, pos + length))
            pos += length
        } else {
            var content = source.substring(pos + length, end - length)
            val padded = content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.isNotBlank()
            if (padded) content = content.substring(1, content.length - 1)
            addCode(content)
            pos = end
        }
        return true
    }

    private fun angle(): Boolean {
        if (source[pos] != '<') return false
        val tag = TAG_PATTERN.matchAt(source, pos)
        val lineBreak = BREAK_PATTERN.matchAt(source, pos)
        return when {
            source.startsWith(CODE_BREAK_TAG, pos) -> {
                addCode("\n")
                pos += CODE_BREAK_TAG.length
                true
            }
            tag != null -> {
                flush()
                val open = tag.groupValues[1].isEmpty()
                if (tag.groupValues[2].lowercase().let { it == "strong" || it == "b" }) bold = open else italic = open
                pos += tag.value.length
                true
            }
            lineBreak != null -> {
                buffer.append('\n')
                pos += lineBreak.value.length
                true
            }
            else -> false
        }
    }

    private fun link(): Boolean {
        if (source[pos] != '[' || href != null) return false
        val end = PageInlineSyntax.findLinkTextEnd(source, pos)
        val destination = if (end == -1) null else PageLinkDestination.parse(source, end + 1)
        if (destination != null) {
            flush()
            val label = source.substring(pos + 1, end)
            InlineScanner(label, bold, italic, PageInlineSyntax.withScheme(destination.first), runs).scan()
            pos = destination.second
        }
        return destination != null
    }

    private fun strong(): Boolean {
        if (source[pos] != '*' || at(pos + 1) != '*') return false
        val opens = !bold && !PageInlineSyntax.isSpace(at(pos + 2)) &&
            PageInlineSyntax.findDelimiter(source, pos + 2, BOLD_TOKEN) {
                !PageInlineSyntax.isSpace(at(it - 1))
            } != -1
        val changes = bold || opens
        if (changes) {
            flush()
            bold = opens
            pos += BOLD_TOKEN.length
        }
        return changes
    }

    private fun emphasisStar(): Boolean {
        if (source[pos] != '*' || at(pos + 1) == '*') return false
        val single = { index: Int -> at(index + 1) != '*' && at(index - 1) != '*' }
        val opens = !italic && !PageInlineSyntax.isSpace(at(pos + 1)) &&
            PageInlineSyntax.findDelimiter(source, pos + 1, "*", single) != -1
        val changes = italic || opens
        if (changes) {
            flush()
            italic = opens
            pos += 1
        }
        return changes
    }

    private fun emphasisUnderscore(): Boolean {
        if (source[pos] != '_') return false
        val notInWord = { index: Int -> !PageInlineSyntax.isWordChar(at(index + 1)) }
        val opens = !italic && !PageInlineSyntax.isWordChar(at(pos - 1)) && !PageInlineSyntax.isSpace(at(pos + 1)) &&
            PageInlineSyntax.findDelimiter(source, pos + 1, "_", notInWord) != -1
        val closes = italic && notInWord(pos)
        if (opens || closes) {
            flush()
            italic = opens
            pos += 1
        }
        return opens || closes
    }
}
