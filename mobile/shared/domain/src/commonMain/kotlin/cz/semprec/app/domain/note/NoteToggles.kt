package cz.semprec.app.domain.note

import cz.semprec.app.domain.PageBlockType

/**
 * A toggle and a toggle heading hold their children, the blocks right after them that are indented deeper. Enter in
 * an open one adds a first child; Enter in a closed one adds the next block after its children, which stay inside.
 * A toggle at [NOTE_MAX_INDENT] can hold no children, since no block is indented deeper: a block meant for its
 * children goes after it at its indent instead, as for a closed toggle.
 */
object NoteToggles {

    /** Whether [block] holds the blocks indented under it. */
    fun folds(block: NoteBlock): Boolean = block.type == PageBlockType.TOGGLE || block.toggle

    /** The index right after the children of the block at [index]. */
    fun childrenEnd(blocks: List<NoteBlock>, index: Int): Int {
        val indent = blocks[index].indent
        var end = index + 1
        while (end < blocks.size && blocks[end].indent > indent) end++
        return end
    }

    /**
     * Enter at [offset] (inside the text, not at its start) of the toggle at [index]: the text after the cursor
     * becomes the toggle's first child, a text block, when it is open ([folded] false); when it is closed, it becomes
     * the next block of the toggle's kind after the children, as it does when the toggle can hold no children.
     */
    fun split(blocks: List<NoteBlock>, index: Int, offset: Int, folded: Boolean, newId: () -> String): NoteChange {
        val toggle = blocks[index]
        val (left, right) = NoteRuns.split(toggle.runs, offset)
        val kept = blocks.replacing(index, toggle.copy(runs = left))
        val (position, created) = if (folded || !holdsChildren(toggle)) {
            childrenEnd(blocks, index) to NoteBlock(newId(), toggle.nextType, toggle.indent, runs = right)
        } else {
            index + 1 to NoteBlock(newId(), PageBlockType.TEXT, toggle.indent + 1, runs = right)
        }
        return NoteChange(kept.inserting(position, created), NoteCaret(created.id, 0))
    }

    /**
     * An empty first child for the toggle [blockId], with the cursor in it; for a toggle that can hold no children an
     * empty text block after it at its indent.
     */
    fun addChild(blocks: List<NoteBlock>, blockId: String, newId: () -> String): NoteChange {
        val index = blocks.indexOfFirst { it.id == blockId }
        val toggle = blocks.getOrNull(index) ?: return NoteChange(blocks, null)
        val indent = if (holdsChildren(toggle)) toggle.indent + 1 else toggle.indent
        val child = NoteBlock(newId(), PageBlockType.TEXT, indent)
        return NoteChange(blocks.inserting(index + 1, child), NoteCaret(child.id, 0))
    }

    private fun holdsChildren(toggle: NoteBlock): Boolean = toggle.indent < NOTE_MAX_INDENT
}
