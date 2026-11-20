package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun

/** An inline format a stretch of text can have. */
enum class NoteMark { BOLD, ITALIC, CODE, STRIKE, UNDERLINE }

/**
 * Formatted text as runs: cutting, joining and formatting stretches of it. Offsets count UTF-16 units of the plain
 * text. Runs that end up next to each other with the same format are joined, and empty runs are dropped.
 */
object NoteRuns {

    /** The runs before [offset] and from it on. */
    fun split(runs: List<InlineRun>, offset: Int): Pair<List<InlineRun>, List<InlineRun>> =
        slice(runs, 0, offset) to slice(runs, offset, Int.MAX_VALUE)

    /** The runs between [start] (inclusive) and [end] (exclusive). */
    fun slice(runs: List<InlineRun>, start: Int, end: Int): List<InlineRun> {
        val result = mutableListOf<InlineRun>()
        var position = 0
        for (run in runs) {
            val from = (start - position).coerceIn(0, run.text.length)
            val to = (end - position).coerceIn(0, run.text.length)
            if (to > from) result += run.copy(text = run.text.substring(from, to))
            position += run.text.length
        }
        return joined(result)
    }

    /** [first] followed by [second], with touching runs of the same format joined. */
    fun concat(first: List<InlineRun>, second: List<InlineRun>): List<InlineRun> = joined(first + second)

    /** Plain text inserted at [offset], taking the format of the run it lands in (or before it). */
    fun insert(runs: List<InlineRun>, offset: Int, text: String): List<InlineRun> {
        val (before, after) = split(runs, offset)
        val format = before.lastOrNull() ?: after.firstOrNull() ?: InlineRun("")
        return joined(before + format.copy(text = text) + after)
    }

    /** Whether all text between [start] and [end] has [mark]; an empty range asks about the run at [start]. */
    fun has(runs: List<InlineRun>, start: Int, end: Int, mark: NoteMark): Boolean {
        val range = if (end > start) slice(runs, start, end) else slice(runs, (start - 1).coerceAtLeast(0), start)
        return range.isNotEmpty() && range.all { it.has(mark) }
    }

    /** [mark] set on (or, when all of it already has it, taken off) the text between [start] and [end]. */
    fun toggle(runs: List<InlineRun>, start: Int, end: Int, mark: NoteMark): List<InlineRun> {
        val on = !has(runs, start, end, mark)
        return restyle(runs, start, end) { it.with(mark, on) }
    }

    /** The text between [start] and [end] linked to [href], or unlinked when [href] is `null`. */
    fun link(runs: List<InlineRun>, start: Int, end: Int, href: String?): List<InlineRun> =
        restyle(runs, start, end) { it.copy(link = href) }

    internal fun restyle(
        runs: List<InlineRun>,
        start: Int,
        end: Int,
        change: (InlineRun) -> InlineRun,
    ): List<InlineRun> {
        val before = slice(runs, 0, start)
        val middle = slice(runs, start, end).map(change)
        val after = slice(runs, end, Int.MAX_VALUE)
        return joined(before + middle + after)
    }

    private fun joined(runs: List<InlineRun>): List<InlineRun> = runs.filter { it.text.isNotEmpty() }
        .fold(mutableListOf()) { acc, run ->
            val last = acc.lastOrNull()
            if (last != null && last.copy(text = "") == run.copy(text = "")) {
                acc[acc.lastIndex] = last.copy(text = last.text + run.text)
            } else {
                acc += run
            }
            acc
        }
}

private fun InlineRun.has(mark: NoteMark): Boolean = when (mark) {
    NoteMark.BOLD -> bold
    NoteMark.ITALIC -> italic
    NoteMark.CODE -> code
    NoteMark.STRIKE -> strike
    NoteMark.UNDERLINE -> underline
}

private fun InlineRun.with(mark: NoteMark, on: Boolean): InlineRun = when (mark) {
    NoteMark.BOLD -> copy(bold = on)
    NoteMark.ITALIC -> copy(italic = on)
    NoteMark.CODE -> copy(code = on)
    NoteMark.STRIKE -> copy(strike = on)
    NoteMark.UNDERLINE -> copy(underline = on)
}
