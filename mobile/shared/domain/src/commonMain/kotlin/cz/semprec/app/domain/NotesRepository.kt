package cz.semprec.app.domain

import cz.semprec.app.core.NoteBlockType

/** One block of a page: [text] is inline Markdown (bold, italic, code, links); [pageId] is set for a subpage. */
data class NoteBlock(
    val id: String,
    val type: NoteBlockType,
    val indent: Int,
    val done: Boolean,
    val text: String,
    val pageId: String?,
)

/** A page as the server summarizes it: its [title] and its blocks in order. */
data class NotePage(val title: String, val blocks: List<NoteBlock>)

/** Where Markdown is inserted into a page. */
sealed interface NotePlacement {
    data object Start : NotePlacement
    data object End : NotePlacement
    data class After(val blockId: String) : NotePlacement
}

/**
 * The page operations of the server that the notes screen uses: reading a page, inserting Markdown, making subpages
 * (also out of blocks that are already there) and turning a subpage block back into an ordinary block. Every failure
 * is a value.
 */
interface NotesRepository {
    suspend fun read(itemId: String): RepositoryResult<NotePage>

    suspend fun insert(itemId: String, placement: NotePlacement, markdown: String): RepositoryResult<Unit>

    /**
     * Makes an empty subpage after [afterBlockId] (at the end without one), or one subpage out of each of
     * [fromBlockIds], which are converted in place; [title] is ignored then.
     */
    suspend fun createSubpage(
        itemId: String,
        afterBlockId: String?,
        title: String?,
        fromBlockIds: List<String>,
    ): RepositoryResult<Unit>

    /**
     * Restyles the subpage block [blockId] into a block of [type]; the subpage tree it named goes to the trash.
     * [confirmedPageCount] is the number of pages the person was shown.
     */
    suspend fun convertToBlock(
        itemId: String,
        blockId: String,
        type: NoteBlockType,
        confirmedPageCount: Int,
    ): RepositoryResult<Unit>

    suspend fun rename(pageItemId: String, title: String): RepositoryResult<Unit>
}

/** The Markdown of a new block of [type] with [text]; a subpage is made by the server, not written as Markdown. */
fun noteMarkdown(type: NoteBlockType, text: String): String? = when (type) {
    NoteBlockType.TEXT -> text
    NoteBlockType.H1 -> "# $text"
    NoteBlockType.H2 -> "## $text"
    NoteBlockType.H3 -> "### $text"
    NoteBlockType.BULLET -> "- $text"
    NoteBlockType.NUMBER -> "1. $text"
    NoteBlockType.TODO -> "- [ ] $text"
    NoteBlockType.QUOTE -> "> $text"
    NoteBlockType.PAGE -> null
}
