package cz.alldots.app.domain.note

import cz.alldots.app.domain.InlineRun
import cz.alldots.app.domain.PageBlockType

/**
 * What the keys do while a block is edited: Enter, Backspace at the start, Delete at the end, Cmd+Enter and the
 * Markdown prefixes typed at the start of a text block. Nothing is ever typed into a page block.
 */
object NoteTyping {

    /**
     * Enter at [caret]: a page block only ends editing. An empty block steps out (less indent, then text, then a new
     * text block below). At the start of a block with text an empty block goes above it. Anywhere else the block
     * splits there; the new block keeps a list's or a toggle's type and the indent, is not done, and gets the cursor. A
     * toggle with text splits into its children instead ([NoteToggles.split]); [folded] says whether it is closed.
     */
    fun enter(blocks: List<NoteBlock>, caret: NoteCaret, newId: () -> String, folded: Boolean = false): NoteChange {
        val index = blocks.indexOfFirst { it.id == caret.blockId }
        val block = blocks.getOrNull(index)
        return when {
            block == null || block.type == PageBlockType.PAGE -> NoteChange(blocks, null)
            block.plainText.isEmpty() -> stepOut(blocks, index, newId)
            caret.offset <= 0 -> {
                val above = NoteBlock(newId(), block.nextType, block.indent)
                NoteChange(blocks.inserting(index, above), caret.copy(offset = 0))
            }
            NoteToggles.folds(block) -> NoteToggles.split(blocks, index, caret.offset, folded, newId)
            else -> {
                val (left, right) = NoteRuns.split(block.runs, caret.offset)
                val below = NoteBlock(newId(), block.nextType, block.indent, runs = right)
                val updated = blocks.replacing(index, block.copy(runs = left)).inserting(index + 1, below)
                NoteChange(updated, NoteCaret(below.id, 0))
            }
        }
    }

    /**
     * Backspace at the start of [blockId]: less indent first, then a plain text block, then the block joins the one
     * above (which keeps its id, type and indent). An empty block after a page block disappears; a block with text
     * after one stays, since nothing is ever written into a page block.
     */
    fun backspaceAtStart(blocks: List<NoteBlock>, blockId: String, newId: () -> String): NoteChange {
        val index = blocks.indexOfFirst { it.id == blockId }
        val block = blocks.getOrNull(index) ?: return NoteChange(blocks, null)
        val previous = blocks.getOrNull(index - 1)
        val here = NoteCaret(blockId, 0)
        return when {
            block.indent > 0 -> NoteChange(blocks.replacing(index, block.copy(indent = block.indent - 1)), here)
            block.type != PageBlockType.TEXT -> NoteChange(blocks.replacing(index, block.asText()), here)
            previous == null -> NoteChange(blocks, here)
            previous.type == PageBlockType.PAGE ->
                if (block.plainText.isEmpty()) removeAfterPage(blocks, index, newId) else NoteChange(blocks, here)
            else -> {
                val joined = previous.copy(runs = NoteRuns.concat(previous.runs, block.runs))
                val updated = blocks.replacing(index - 1, joined).removing(index)
                NoteChange(updated, NoteCaret(previous.id, previous.plainText.length))
            }
        }
    }

    /** Delete at the end of [blockId]: the next block joins this one, unless it is a page block or there is none. */
    fun deleteAtEnd(blocks: List<NoteBlock>, blockId: String): NoteChange {
        val index = blocks.indexOfFirst { it.id == blockId }
        val block = blocks.getOrNull(index) ?: return NoteChange(blocks, null)
        val next = blocks.getOrNull(index + 1)
        val caret = NoteCaret(blockId, block.plainText.length)
        val joins = next != null && next.type != PageBlockType.PAGE && block.type != PageBlockType.PAGE
        val joined = if (joins && next != null) {
            blocks.replacing(index, block.copy(runs = NoteRuns.concat(block.runs, next.runs))).removing(index + 1)
        } else {
            blocks
        }
        return NoteChange(joined, caret)
    }

    /** Cmd+Enter on [blockId]: a to-do is ticked or unticked; any other line becomes a to-do. */
    fun commandEnter(blocks: List<NoteBlock>, blockId: String): List<NoteBlock> = blocks.map { block ->
        when {
            block.id != blockId || block.type == PageBlockType.PAGE -> block
            block.type == PageBlockType.TODO -> block.copy(done = !block.done)
            else -> block.copy(type = PageBlockType.TODO, done = false)
        }
    }

    /**
     * A Markdown prefix typed at the start of a text block turns it into its type and is removed, the cursor going
     * to the start: `#`, `##`, `###`, `-`, `*`, `•`, `1.`, `1)`, `[]`, `[ ]`, `[x]` and `>`, each with a space.
     * `null` when [blockId] is not a text block starting with one.
     */
    fun applyPrefix(blocks: List<NoteBlock>, blockId: String): NoteChange? {
        val index = blocks.indexOfFirst { it.id == blockId }
        val block = blocks.getOrNull(index)?.takeIf { it.type == PageBlockType.TEXT }
        val match = block?.let { found -> PREFIXES.firstOrNull { found.plainText.startsWith(it.first) } }
        return if (block != null && match != null) {
            val (prefix, type) = match
            val done = type == PageBlockType.TODO && prefix.startsWith("[x", ignoreCase = true)
            val runs = NoteRuns.slice(block.runs, prefix.length, Int.MAX_VALUE)
            val updated = blocks.replacing(index, block.copy(type = type, done = done, runs = runs))
            NoteChange(updated, NoteCaret(blockId, 0))
        } else {
            null
        }
    }

    private val PREFIXES: List<Pair<String, PageBlockType>> = listOf(
        "### " to PageBlockType.H3,
        "## " to PageBlockType.H2,
        "# " to PageBlockType.H1,
        "- " to PageBlockType.BULLET,
        "* " to PageBlockType.BULLET,
        "• " to PageBlockType.BULLET,
        "1. " to PageBlockType.NUMBER,
        "1) " to PageBlockType.NUMBER,
        "[] " to PageBlockType.TODO,
        "[ ] " to PageBlockType.TODO,
        "[x] " to PageBlockType.TODO,
        "[X] " to PageBlockType.TODO,
        "> " to PageBlockType.QUOTE,
    )

    private fun stepOut(blocks: List<NoteBlock>, index: Int, newId: () -> String): NoteChange {
        val block = blocks[index]
        val here = NoteCaret(block.id, 0)
        return when {
            block.indent > 0 -> NoteChange(blocks.replacing(index, block.copy(indent = block.indent - 1)), here)
            block.type != PageBlockType.TEXT -> NoteChange(blocks.replacing(index, block.asText()), here)
            else -> {
                val below = NoteBlock(newId(), PageBlockType.TEXT)
                NoteChange(blocks.inserting(index + 1, below), NoteCaret(below.id, 0))
            }
        }
    }

    /** Takes away an empty block after a page block; the cursor goes to the end of the nearest text above it. */
    private fun removeAfterPage(blocks: List<NoteBlock>, index: Int, newId: () -> String): NoteChange {
        val remaining = NoteDocument.normalize(blocks.removing(index), newId)
        val target = remaining.take(index).lastOrNull { it.type != PageBlockType.PAGE }
        return NoteChange(remaining, target?.let { NoteCaret(it.id, it.plainText.length) })
    }
}

/** The block as plain text: not done, and no longer a toggle heading. */
private fun NoteBlock.asText(): NoteBlock = copy(type = PageBlockType.TEXT, done = false, toggle = false)

internal fun <T> List<T>.replacing(index: Int, value: T): List<T> = toMutableList().also { it[index] = value }

internal fun <T> List<T>.inserting(index: Int, value: T): List<T> = toMutableList().also { it.add(index, value) }

internal fun <T> List<T>.removing(index: Int): List<T> = toMutableList().also { it.removeAt(index) }

/** Runs of plain text, for a block made from typed or pasted text. */
internal fun plainRuns(text: String): List<InlineRun> = if (text.isEmpty()) emptyList() else listOf(InlineRun(text))
