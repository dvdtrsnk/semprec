package cz.alldots.app.domain.note

import cz.alldots.app.domain.InlineRun
import cz.alldots.app.domain.PageBlockType
import cz.alldots.app.domain.PageMarkdownWriter

/**
 * Changes to a note's blocks as a whole: their text, type, indent and place, duplicates and deletion. A page block
 * changes type only through the subpage operations of the server, never here.
 */
object NoteStructure {

    /** The text of [blockId] replaced by [runs]. A page block's caption is plain text only. */
    fun setRuns(blocks: List<NoteBlock>, blockId: String, runs: List<InlineRun>): List<NoteBlock> = blocks.map {
        when {
            it.id != blockId -> it
            it.type == PageBlockType.PAGE -> it.copy(runs = plainRuns(runs.joinToString("") { run -> run.text }))
            else -> it.copy(runs = runs)
        }
    }

    /**
     * [ids] set to [type], which is not a page, and a heading folding the blocks under it when [toggle]; a change of
     * type takes `done` away. Page blocks stay.
     */
    fun setType(
        blocks: List<NoteBlock>,
        ids: Set<String>,
        type: PageBlockType,
        toggle: Boolean = false,
    ): List<NoteBlock> {
        require(type != PageBlockType.PAGE) { "A block becomes a page only through the subpage operation" }
        val folds = toggle && PageMarkdownWriter.isHeading(type)
        return blocks.map {
            val changes = it.id in ids && it.type != PageBlockType.PAGE && (it.type != type || it.toggle != folds)
            if (changes) it.copy(type = type, done = it.done && it.type == type, toggle = folds) else it
        }
    }

    /** [ids] switched between [type] and text: all to text when all already have [type], otherwise all to [type]. */
    fun toggleType(blocks: List<NoteBlock>, ids: Set<String>, type: PageBlockType): List<NoteBlock> {
        val targets = blocks.filter { it.id in ids && it.type != PageBlockType.PAGE }
        val allHave = targets.isNotEmpty() && targets.all { it.type == type }
        return setType(blocks, ids, if (allHave) PageBlockType.TEXT else type)
    }

    /** [ids] indented by [delta] levels, kept within 0 to [NOTE_MAX_INDENT]. */
    fun shiftIndent(blocks: List<NoteBlock>, ids: Set<String>, delta: Int): List<NoteBlock> = blocks.map {
        if (it.id in ids) it.copy(indent = (it.indent + delta).coerceIn(0, NOTE_MAX_INDENT)) else it
    }

    /** The to-do [blockId] ticked or unticked; any other block stays. */
    fun toggleDone(blocks: List<NoteBlock>, blockId: String): List<NoteBlock> = blocks.map {
        if (it.id == blockId && it.type == PageBlockType.TODO) it.copy(done = !it.done) else it
    }

    /**
     * [ids] moved together, in their order, so that they stand before the block that was at [targetIndex] among all
     * blocks ([blocks].size for the end), each indented by [indentDelta] more levels, kept within 0 to
     * [NOTE_MAX_INDENT].
     */
    fun move(blocks: List<NoteBlock>, ids: Set<String>, targetIndex: Int, indentDelta: Int = 0): List<NoteBlock> {
        val moving = blocks.filter { it.id in ids }
            .map { it.copy(indent = (it.indent + indentDelta).coerceIn(0, NOTE_MAX_INDENT)) }
        if (moving.isEmpty()) return blocks
        val before = blocks.take(targetIndex.coerceIn(0, blocks.size)).count { it.id !in ids }
        val rest = blocks.filter { it.id !in ids }
        return rest.take(before) + moving + rest.drop(before)
    }

    /**
     * Copies of [ids] right after the last of them, in their order, with new ids. A page block is not copied here:
     * its subpage and the pages under it are copied by the server, which adds its block itself.
     */
    fun duplicate(blocks: List<NoteBlock>, ids: Set<String>, newId: () -> String): List<NoteBlock> {
        val last = blocks.indexOfLast { it.id in ids }
        if (last < 0) return blocks
        val copies = blocks.filter { it.id in ids && it.type != PageBlockType.PAGE }.map { it.copy(id = newId()) }
        return blocks.take(last + 1) + copies + blocks.drop(last + 1)
    }

    /** [ids] removed; a note left with no block keeps one empty text block. */
    fun delete(blocks: List<NoteBlock>, ids: Set<String>, newId: () -> String): List<NoteBlock> =
        NoteDocument.normalize(blocks.filter { it.id !in ids }, newId)

    /**
     * A tap below the last block: the cursor goes into the last block when it is an empty text block, otherwise into
     * a new empty text block added at the end.
     */
    fun tapBelow(blocks: List<NoteBlock>, newId: () -> String): NoteChange {
        val last = blocks.lastOrNull()
        if (last != null && last.type == PageBlockType.TEXT && last.plainText.isEmpty()) {
            return NoteChange(blocks, NoteCaret(last.id, 0))
        }
        val added = NoteBlock(newId(), PageBlockType.TEXT)
        return NoteChange(blocks + added, NoteCaret(added.id, 0))
    }
}
