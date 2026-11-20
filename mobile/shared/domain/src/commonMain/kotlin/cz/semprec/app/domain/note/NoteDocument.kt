package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.PageBlock
import cz.semprec.app.domain.PageBlockType
import cz.semprec.app.domain.PageMarkdown
import cz.semprec.app.domain.PageMarkdownWriter

/** The deepest indent a block takes (docs/adr/2026-10-28-block-model-for-page-documents.md). */
const val NOTE_MAX_INDENT = 5

/**
 * One block of a note as the editor holds it. [id] is local to the editor: the server pairs blocks by content when a
 * page is replaced, so it never sees these ids. [preservedType] is the type key of a block another client wrote with
 * a type this app does not know; the block shows as text and keeps its key when written back unchanged.
 */
data class NoteBlock(
    val id: String,
    val type: PageBlockType,
    val indent: Int = 0,
    val done: Boolean = false,
    val runs: List<InlineRun> = emptyList(),
    val pageId: String? = null,
    val preservedType: String? = null,
    /** A heading that folds the blocks under it (a toggle heading). */
    val toggle: Boolean = false,
) {
    val plainText: String get() = runs.joinToString("") { it.text }

    /** Whether the block is a list item. */
    val isList: Boolean get() = PageMarkdownWriter.isList(type)

    /** The type a block made by Enter or a pasted line after this one gets: a list item's or a toggle's own. */
    val nextType: PageBlockType get() = if (isList || type == PageBlockType.TOGGLE) type else PageBlockType.TEXT
}

/** Where the text cursor is: in [blockId], [offset] UTF-16 units from the start of its text. */
data class NoteCaret(val blockId: String, val offset: Int)

/** The blocks after an edit and where the cursor goes; a `null` [caret] ends editing. */
data class NoteChange(val blocks: List<NoteBlock>, val caret: NoteCaret?)

/** Reading, normalizing and writing a note's blocks. Reading writes nothing back. */
object NoteDocument {

    /** The blocks of the canonical Markdown [markdown], normalized; never empty. */
    fun read(markdown: String, newId: () -> String): List<NoteBlock> =
        normalize(PageMarkdown.parse(markdown).map { it.toNoteBlock(newId()) }, newId)

    /**
     * The blocks as the editor may hold them: at least one block, indents within 0 to [NOTE_MAX_INDENT], `done` only
     * on a to-do, a page id only on a page block, a page block only with a page id and a toggle only on a heading.
     */
    fun normalize(blocks: List<NoteBlock>, newId: () -> String): List<NoteBlock> {
        val fitted = blocks.map { block ->
            val isPage = block.type == PageBlockType.PAGE && !block.pageId.isNullOrEmpty()
            val type = if (block.type == PageBlockType.PAGE && !isPage) PageBlockType.TEXT else block.type
            block.copy(
                type = type,
                indent = block.indent.coerceIn(0, NOTE_MAX_INDENT),
                done = block.done && type == PageBlockType.TODO,
                pageId = block.pageId.takeIf { isPage },
                toggle = block.toggle && PageMarkdownWriter.isHeading(type),
            )
        }
        return fitted.ifEmpty { listOf(NoteBlock(newId(), PageBlockType.TEXT)) }
    }

    /** The canonical Markdown of [blocks]: a blank line between blocks, none between list items in a row. */
    fun markdown(blocks: List<NoteBlock>): String {
        val lines = mutableListOf<String>()
        var previousWasList = false
        for (block in blocks) {
            val page = block.toPageBlock()
            if (lines.isNotEmpty() && !(block.isList && previousWasList)) lines += ""
            lines += PageMarkdownWriter.blockLines(page)
            previousWasList = block.isList
        }
        return lines.joinToString("\n")
    }

    /** How many words the note has, its subpage captions included. */
    fun wordCount(blocks: List<NoteBlock>): Int =
        blocks.sumOf { block -> block.plainText.split(WORD_GAP).count { it.isNotEmpty() } }

    /** Whether the note holds nothing but one empty text block. */
    fun isBlank(blocks: List<NoteBlock>): Boolean =
        blocks.size == 1 && blocks.first().type == PageBlockType.TEXT && blocks.first().plainText.isEmpty()

    private val WORD_GAP = Regex("\\s+")
}

private fun PageBlock.toNoteBlock(id: String) =
    NoteBlock(id, type, indent, done, runs, pageId, preservedType, toggle = toggle)

private fun NoteBlock.toPageBlock() = PageBlock(
    type = type,
    indent = indent,
    done = done,
    runs = runs.filter { it.text.isNotEmpty() },
    pageId = pageId,
    firstLine = 0,
    lastLine = 0,
    preservedType = preservedType,
    toggle = toggle,
)
