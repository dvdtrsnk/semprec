package cz.alldots.app.domain

private const val BOLD_TOKEN = "**"
private const val STRIKE_TOKEN = "~~"
private const val CODE_BREAK_TAG = "<code><br></code>"
private val BREAK_PATTERN = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)

/**
 * Reads the inline part of the canonical page Markdown (a deliberate subset, not CommonMark) into typed runs, the
 * same way `shared/block-model/src/markdown.ts` does: emphasis, strikethrough, underline, text color and highlight
 * tags, code, links, soft breaks and the escapes the serializer writes. Screens render the runs; they never see the
 * syntax.
 */
object PageInlineParser {
    fun parse(source: String): List<InlineRun> {
        val raw = mutableListOf<InlineRun>()
        InlineScanner(source, InlineRun(""), raw).scan()
        val merged = mutableListOf<InlineRun>()
        for (run in raw) {
            val last = merged.lastOrNull()
            if (last != null && last.copy(text = "") == run.copy(text = "")) {
                merged[merged.lastIndex] = last.copy(text = last.text + run.text)
            } else if (run.text.isNotEmpty()) {
                merged += run
            }
        }
        return merged
    }
}

/** Scans [source] with [style] as the formatting in effect at its start; [style] has empty text. */
private class InlineScanner(
    private val source: String,
    private var style: InlineRun,
    private val runs: MutableList<InlineRun>,
) {
    private val at: (Int) -> Char? = source::getOrNull
    private var pos = 0
    private val buffer = StringBuilder()

    fun scan() {
        val steps = listOf(
            ::escape, ::code, ::angle, ::link, ::strong, ::strike, ::emphasisStar, ::emphasisUnderscore,
        )
        while (pos < source.length) {
            if (!steps.any { it() }) {
                buffer.append(source[pos])
                pos += 1
            }
        }
        flush()
    }

    /** Ends the plain text read so far, then adds [code] as a code run when given. */
    private fun flush(code: String? = null) {
        if (buffer.isNotEmpty()) runs += style.copy(text = buffer.toString())
        buffer.clear()
        if (code != null) runs += style.copy(text = code, code = true)
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
            flush(code = content)
            pos = end
        }
        return true
    }

    private fun angle(): Boolean {
        if (source[pos] != '<') return false
        val tag = PageInlineTags.at(source, pos)
        val lineBreak = BREAK_PATTERN.matchAt(source, pos)
        return when {
            source.startsWith(CODE_BREAK_TAG, pos) -> {
                flush(code = "\n")
                pos += CODE_BREAK_TAG.length
                true
            }
            tag != null -> {
                flush()
                style = tag.apply(style)
                pos += tag.length
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
        if (source[pos] != '[' || style.link != null) return false
        val end = PageInlineSyntax.findLinkTextEnd(source, pos)
        val destination = if (end == -1) null else PageLinkDestination.parse(source, end + 1)
        if (destination != null) {
            flush()
            val label = source.substring(pos + 1, end)
            InlineScanner(label, style.copy(link = PageInlineSyntax.withScheme(destination.first)), runs).scan()
            pos = destination.second
        }
        return destination != null
    }

    private fun strong(): Boolean {
        if (source[pos] != '*' || at(pos + 1) != '*') return false
        val opens = !style.bold && !PageInlineSyntax.isSpace(at(pos + 2)) &&
            PageInlineSyntax.findDelimiter(source, pos + 2, BOLD_TOKEN) {
                !PageInlineSyntax.isSpace(at(it - 1))
            } != -1
        val changes = style.bold || opens
        if (changes) {
            flush()
            style = style.copy(bold = opens)
            pos += BOLD_TOKEN.length
        }
        return changes
    }

    /** `~~` closes an open strikethrough, and opens one only when a closing `~~` follows. */
    private fun strike(): Boolean {
        if (!source.startsWith(STRIKE_TOKEN, pos)) return false
        val changes = style.strike ||
            PageInlineSyntax.findDelimiter(source, pos + STRIKE_TOKEN.length, STRIKE_TOKEN) { true } != -1
        if (changes) {
            flush()
            style = style.copy(strike = !style.strike)
            pos += STRIKE_TOKEN.length
        }
        return changes
    }

    private fun emphasisStar(): Boolean {
        if (source[pos] != '*' || at(pos + 1) == '*') return false
        val single = { index: Int -> at(index + 1) != '*' && at(index - 1) != '*' }
        val opens = !style.italic && !PageInlineSyntax.isSpace(at(pos + 1)) &&
            PageInlineSyntax.findDelimiter(source, pos + 1, "*", single) != -1
        val changes = style.italic || opens
        if (changes) {
            flush()
            style = style.copy(italic = opens)
            pos += 1
        }
        return changes
    }

    private fun emphasisUnderscore(): Boolean {
        if (source[pos] != '_') return false
        val notInWord = { index: Int -> !PageInlineSyntax.isWordChar(at(index + 1)) }
        val opens = !style.italic && !PageInlineSyntax.isWordChar(at(pos - 1)) &&
            !PageInlineSyntax.isSpace(at(pos + 1)) &&
            PageInlineSyntax.findDelimiter(source, pos + 1, "_", notInWord) != -1
        val closes = style.italic && notInWord(pos)
        if (opens || closes) {
            flush()
            style = style.copy(italic = opens)
            pos += 1
        }
        return opens || closes
    }
}
