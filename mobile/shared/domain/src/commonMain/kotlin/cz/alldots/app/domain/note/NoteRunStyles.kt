package cz.alldots.app.domain.note

import cz.alldots.app.domain.InlineColor
import cz.alldots.app.domain.InlineRun

/** The colours of stretches of formatted text, and taking every format off. Offsets count UTF-16 units. */
object NoteRunStyles {

    /** [start]..[end] in the text colour [color], or the default colour with `null`. */
    fun color(runs: List<InlineRun>, start: Int, end: Int, color: InlineColor?): List<InlineRun> =
        NoteRuns.restyle(runs, start, end) { it.copy(color = color) }

    /** [start]..[end] highlighted in [color], or not highlighted with `null`. */
    fun highlight(runs: List<InlineRun>, start: Int, end: Int, color: InlineColor?): List<InlineRun> =
        NoteRuns.restyle(runs, start, end) { it.copy(highlight = color) }

    /** [start]..[end] as plain text: no format, no colour and no link. */
    fun clear(runs: List<InlineRun>, start: Int, end: Int): List<InlineRun> =
        NoteRuns.restyle(runs, start, end) { InlineRun(it.text) }
}
