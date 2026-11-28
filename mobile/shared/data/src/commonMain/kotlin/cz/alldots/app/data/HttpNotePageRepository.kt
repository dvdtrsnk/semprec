package cz.alldots.app.data

import cz.alldots.app.domain.JournalRepository
import cz.alldots.app.domain.PageDocument
import cz.alldots.app.domain.PageWrite
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.note.NotePageInfo
import cz.alldots.app.domain.note.NotePageRepository
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A block of the summary `GET /api/items/:id/page` answers; the note editor reads only its id. */
@Serializable
internal data class NoteBlockDto(val id: String)

/** The summary `GET /api/items/:id/page` answers, the fields the note editor reads. */
@Serializable
internal data class NotePageInfoDto(
    val title: String = "",
    val blocks: List<NoteBlockDto> = emptyList(),
    val lastEditedAt: String? = null,
)

/**
 * The note editor's page routes. The Markdown read and replace are the Journal's `page.md` routes, so both write
 * pages the same way; the summary and the subpage operations are the item page routes.
 */
class HttpNotePageRepository(
    private val api: AuthenticatedApi,
    private val markdown: JournalRepository,
) : NotePageRepository {

    override suspend fun read(itemId: String): RepositoryResult<PageDocument> = markdown.page(itemId)

    override suspend fun replace(
        itemId: String,
        markdown: String,
        etag: String,
        base: String,
    ): RepositoryResult<PageWrite> = this.markdown.replacePage(itemId, markdown, etag, base)

    override suspend fun info(itemId: String): RepositoryResult<NotePageInfo> =
        when (val read = api.send(HttpMethod.Get, "/api/items/$itemId/page").decode<NotePageInfoDto>()) {
            is RepositoryResult.Failure -> read
            is RepositoryResult.Content -> with(read.value) {
                RepositoryResult.Content(NotePageInfo(title, blocks.map { it.id }, lastEditedAt))
            }
        }

    override suspend fun subpageFromBlock(itemId: String, blockId: String): RepositoryResult<Unit> {
        val body = buildJsonObject { put("fromBlockIds", JsonArray(listOf(JsonPrimitive(blockId)))) }
        return api.send(HttpMethod.Post, "/api/items/$itemId/page/subpages", body = body.toString()).ignoreBody()
    }

    override suspend fun duplicateSubpage(pageItemId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "/api/items/$pageItemId/page/duplicate", body = "{}").ignoreBody()

    override suspend fun rename(pageItemId: String, title: String): RepositoryResult<Unit> =
        api.send(
            HttpMethod.Patch,
            "/api/items/$pageItemId/page/title",
            body = buildJsonObject { put("title", title) }.toString(),
        ).ignoreBody()
}
