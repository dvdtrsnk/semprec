package cz.semprec.app.domain.note

import cz.semprec.app.domain.PageBlockType

/**
 * Pasting plain text at the cursor. One line goes into the block; several lines become several blocks. A line
 * starting with a Markdown prefix (`- `, `1. `…) keeps its meaning; any other line takes the list type of the block
 * pasted into, or becomes text. Formatting from elsewhere is never pasted.
 */
object NotePaste {

    fun paste(blocks: List<NoteBlock>, caret: NoteCaret, text: String, newId: () -> String): NoteChange {
        val index = blocks.indexOfFirst { it.id == caret.blockId }
        val block = blocks.getOrNull(index)?.takeIf { it.type != PageBlockType.PAGE }
        val lines = text.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        return when {
            block == null -> NoteChange(blocks, caret)
            lines.size == 1 -> {
                val runs = NoteRuns.insert(block.runs, caret.offset, text)
                val moved = caret.copy(offset = caret.offset + text.length)
                NoteChange(blocks.replacing(index, block.copy(runs = runs)), moved)
            }
            else -> pasteLines(blocks, index, caret.offset, lines, newId)
        }
    }

    private fun pasteLines(
        blocks: List<NoteBlock>,
        index: Int,
        offset: Int,
        lines: List<String>,
        newId: () -> String,
    ): NoteChange {
        val block = blocks[index]
        val (left, right) = NoteRuns.split(block.runs, offset)
        val first = block.copy(runs = NoteRuns.concat(left, plainRuns(lines.first())))
        val inherited = if (block.isList) block.type else PageBlockType.TEXT
        val pasted = lines.drop(1).map { line -> lineBlock(line, inherited, block.indent, newId) }
        val lastPasted = pasted.last()
        val tail = lastPasted.copy(runs = NoteRuns.concat(lastPasted.runs, right))
        val updated = blocks.take(index) + first + pasted.dropLast(1) + tail + blocks.drop(index + 1)
        return NoteChange(updated, NoteCaret(tail.id, lastPasted.plainText.length))
    }

    /** One pasted line as a block: its Markdown prefix decides the type, otherwise [inherited]. */
    private fun lineBlock(line: String, inherited: PageBlockType, indent: Int, newId: () -> String): NoteBlock {
        val plain = NoteBlock(newId(), PageBlockType.TEXT, indent, runs = plainRuns(line))
        val prefixed = NoteTyping.applyPrefix(listOf(plain), plain.id)?.blocks?.single()
        return prefixed ?: plain.copy(type = inherited)
    }
}
