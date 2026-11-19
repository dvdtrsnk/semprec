package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.PageBlockType
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.note.NoteDocument
import cz.semprec.app.domain.note.NotePageInfo
import cz.semprec.app.domain.note.NotePageRepository
import kotlinx.coroutines.CompletableDeferred

/**
 * A server of pages kept as Markdown with a version each. A replacement quoting an old version is a conflict, a
 * subpage made from a block turns it into a page block, and a copied subpage gets its block right after the original.
 */
class FakeNotePages : NotePageRepository {
    val markdown = mutableMapOf<String, String>()
    private val versions = mutableMapOf<String, Int>()
    val calls = mutableListOf<String>()
    var failing: String? = null

    /** When set, a replacement is written at once but answered only once it completes, as a slow server does. */
    var replaceGate: CompletableDeferred<Unit>? = null

    fun put(itemId: String, page: String) {
        markdown[itemId] = page
        versions[itemId] = (versions[itemId] ?: 0) + 1
    }

    private fun etag(itemId: String) = "\"v${versions[itemId] ?: 0}\""

    private fun <T> answer(call: String, value: () -> T): RepositoryResult<T> {
        calls += call
        val refused = failing?.let(call::startsWith) == true
        return if (refused) {
            RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        } else {
            RepositoryResult.Content(value())
        }
    }

    override suspend fun read(itemId: String): RepositoryResult<PageDocument> =
        answer("read $itemId") { PageDocument(markdown[itemId].orEmpty(), etag(itemId)) }

    override suspend fun replace(itemId: String, markdown: String, etag: String): RepositoryResult<PageWrite> {
        val written = replaced(itemId, markdown, etag)
        replaceGate?.await()
        return written
    }

    private fun replaced(itemId: String, markdown: String, etag: String): RepositoryResult<PageWrite> =
        answer("replace $itemId") {
            if (etag != etag(itemId)) {
                PageWrite.Conflict
            } else {
                put(itemId, markdown)
                PageWrite.Saved(etag(itemId))
            }
        }

    override suspend fun info(itemId: String): RepositoryResult<NotePageInfo> = answer("info $itemId") {
        val count = blocks(itemId).size
        NotePageInfo("Title of $itemId", List(count) { "s$it" }, "2026-11-01T10:00:00Z")
    }

    override suspend fun subpageFromBlock(itemId: String, blockId: String): RepositoryResult<Unit> =
        answer("subpage $itemId $blockId") {
            val index = blockId.removePrefix("s").toInt()
            val blocks = blocks(itemId).toMutableList()
            val block = blocks[index]
            blocks[index] = block.copy(
                type = PageBlockType.PAGE,
                runs = listOf(InlineRun(block.plainText)),
                pageId = "made-$index",
            )
            put(itemId, NoteDocument.markdown(blocks))
        }

    override suspend fun duplicateSubpage(pageItemId: String): RepositoryResult<Unit> =
        answer("duplicate $pageItemId") {
            val itemId = markdown.keys.first { blocks(it).any { block -> block.pageId == pageItemId } }
            val blocks = blocks(itemId).toMutableList()
            val index = blocks.indexOfFirst { it.pageId == pageItemId }
            val original = blocks[index]
            blocks.add(
                index + 1,
                original.copy(runs = listOf(InlineRun(original.plainText + " (kopie)")), pageId = "$pageItemId-copy"),
            )
            put(itemId, NoteDocument.markdown(blocks))
        }

    override suspend fun rename(pageItemId: String, title: String): RepositoryResult<Unit> =
        answer("rename $pageItemId $title") { }

    private fun blocks(itemId: String) = NoteDocument.read(markdown[itemId].orEmpty()) { "x" }
}
