package cz.alldots.app.domain

/** The formatting of one character, so runs can be rebuilt after a text change. */
private data class Format(val bold: Boolean, val italic: Boolean, val code: Boolean, val link: String?)

/**
 * Turns the new plain text a person typed into runs, keeping the formatting of every part of the old text that
 * stays. The change is found as one replaced stretch between the longest common prefix and suffix; the new
 * characters take the formatting of the character before them, except that they do not continue code or a link
 * past its end.
 */
object PageTextEdit {
    fun apply(runs: List<InlineRun>, newText: String): List<InlineRun> {
        val oldChars = runs.flatMap { run -> run.text.map { it to run.format() } }
        val oldText = oldChars.map { it.first }.joinToString("")
        val prefix = oldText.commonPrefixWith(newText).length
        val maxSuffix = minOf(oldText.length, newText.length) - prefix
        val suffix = oldText.commonSuffixWith(newText).length.coerceAtMost(maxSuffix)
        val insertFormat = insertFormat(oldChars, prefix)
        val formatted = oldChars.take(prefix) +
            newText.substring(prefix, newText.length - suffix).map { it to insertFormat } +
            oldChars.takeLast(suffix)
        return merge(formatted)
    }

    private fun insertFormat(old: List<Pair<Char, Format>>, at: Int): Format {
        val before = old.getOrNull(at - 1)?.second ?: old.getOrNull(at)?.second ?: PLAIN
        val continuesBefore = old.getOrNull(at)?.second == before
        val plain = !before.code && before.link == null
        return if (continuesBefore || plain) before else before.copy(code = false, link = null)
    }

    private fun merge(chars: List<Pair<Char, Format>>): List<InlineRun> {
        val runs = mutableListOf<InlineRun>()
        for ((char, format) in chars) {
            val last = runs.lastOrNull()
            if (last != null && last.format() == format) {
                runs[runs.lastIndex] = last.copy(text = last.text + char)
            } else {
                runs += InlineRun(char.toString(), format.bold, format.italic, format.code, format.link)
            }
        }
        return runs
    }

    private fun InlineRun.format() = Format(bold, italic, code, link)

    private val PLAIN = Format(bold = false, italic = false, code = false, link = null)
}
