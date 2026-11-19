package cz.semprec.app.domain.note

import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.RepositoryResult

/**
 * What the server says about a page beside its Markdown: its [title], the server ids of its blocks in order (which
 * the subpage operations name) and when it was last edited (`null` for a page never written).
 */
data class NotePageInfo(val title: String, val blockIds: List<String>, val lastEditedAt: String?)

/**
 * The page routes the note editor uses. The page itself is read and replaced as canonical Markdown against its
 * version; making a subpage out of a block, copying a subpage tree and renaming a subpage use the page operations.
 * Every failure is a value.
 */
interface NotePageRepository {
    suspend fun read(itemId: String): RepositoryResult<PageDocument>

    /** Replaces the page when [etag] is still its version; otherwise [PageWrite.Conflict]. */
    suspend fun replace(itemId: String, markdown: String, etag: String): RepositoryResult<PageWrite>

    suspend fun info(itemId: String): RepositoryResult<NotePageInfo>

    /** Turns the block [blockId] of the page into a subpage whose title is the block's text. */
    suspend fun subpageFromBlock(itemId: String, blockId: String): RepositoryResult<Unit>

    /** Copies the subpage [pageItemId] with every page under it; the copy's block goes right after the original. */
    suspend fun duplicateSubpage(pageItemId: String): RepositoryResult<Unit>

    suspend fun rename(pageItemId: String, title: String): RepositoryResult<Unit>
}
