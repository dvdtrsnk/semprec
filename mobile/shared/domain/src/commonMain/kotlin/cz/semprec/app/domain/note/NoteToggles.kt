package cz.semprec.app.domain.note

import cz.semprec.app.domain.PageBlockType

/**
 * A toggle and a toggle heading hold their children, the blocks right after them that are indented deeper. Enter in
 * an open one adds a first child; Enter in a closed one adds the next block after its children, which stay inside.
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
     * the next block of the toggle's kind after the children.
     */
    fun split(blocks: List<NoteBlock>, index: Int, offset: Int, folded: Boolean, newId: () -> String): NoteChange {
        val toggle = blocks[index]
        val (left, right) = NoteRuns.split(toggle.runs, offset)
        val kept = blocks.replacing(index, toggle.copy(runs = left))
        val (position, created) = if (folded) {
            childrenEnd(blocks, index) to NoteBlock(newId(), toggle.nextType, toggle.indent, runs = right)
        } else {
            index + 1 to NoteBlock(newId(), PageBlockType.TEXT, toggle.indent + 1, runs = right)
        }
        return NoteChange(kept.inserting(position, created), NoteCaret(created.id, 0))
    }

    /** An empty first child for the toggle [blockId], with the cursor in it. */
    fun addChild(blocks: List<NoteBlock>, blockId: String, newId: () -> String): NoteChange {
        val index = blocks.indexOfFirst { it.id == blockId }
        val toggle = blocks.getOrNull(index) ?: return NoteChange(blocks, null)
        val child = NoteBlock(newId(), PageBlockType.TEXT, toggle.indent + 1)
        return NoteChange(blocks.inserting(index + 1, child), NoteCaret(child.id, 0))
    }
}
