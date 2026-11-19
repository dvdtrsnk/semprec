package cz.semprec.app.domain.note

import cz.semprec.app.domain.PageBlockType

/** What a block shows in front of its text; markers are drawn, never stored. */
sealed interface NoteMarker {
    /** A list bullet; [level] cycles the glyph by indent (filled circle, ring, square). */
    data class Bullet(val level: Int) : NoteMarker

    /** A numbered item's label, `1.` at the top level and `1.1.` under another numbered item. */
    data class Number(val label: String) : NoteMarker
}

/** The markers of a note's blocks, in order; `null` for a block without one. */
object NoteMarkers {
    private const val BULLET_GLYPHS = 3

    fun of(blocks: List<NoteBlock>): List<NoteMarker?> {
        val counters = IntArray(NOTE_MAX_INDENT + 1)
        return blocks.map { block ->
            if (block.type == PageBlockType.NUMBER) {
                counters[block.indent] += 1
                for (deeper in block.indent + 1..NOTE_MAX_INDENT) counters[deeper] = 0
                val path = (0..block.indent).map { counters[it].coerceAtLeast(1) }
                NoteMarker.Number(path.joinToString(".") + ".")
            } else {
                // Anything that is not a numbered item ends the numbering at its own level and deeper.
                for (level in block.indent..NOTE_MAX_INDENT) counters[level] = 0
                if (block.type == PageBlockType.BULLET) NoteMarker.Bullet(block.indent % BULLET_GLYPHS) else null
            }
        }
    }
}
