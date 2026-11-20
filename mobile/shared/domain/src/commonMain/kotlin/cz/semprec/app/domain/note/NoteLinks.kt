package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun

/** Where the links of formatted text are. Offsets count UTF-16 units of the plain text. */
object NoteLinks {

    /** The link the text at [offset] (or just before it) has, if any. */
    fun at(runs: List<InlineRun>, offset: Int): String? =
        NoteRuns.slice(runs, offset, offset + 1).firstOrNull()?.link
            ?: NoteRuns.slice(runs, offset - 1, offset).firstOrNull()?.link

    /** The whole stretch of the one link that the text at [offset] (or just before it) belongs to. */
    fun range(runs: List<InlineRun>, offset: Int): IntRange? {
        val href = at(runs, offset) ?: return null
        var start = 0
        var position = 0
        var range: IntRange? = null
        for (run in runs) {
            val end = position + run.text.length
            if (run.link != href) start = end
            if (run.link == href && offset in start..end) range = start until end
            position = end
        }
        return range
    }
}
