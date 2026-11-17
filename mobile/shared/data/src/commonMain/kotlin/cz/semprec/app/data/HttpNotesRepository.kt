package cz.semprec.app.data

import cz.semprec.app.core.NoteBlockType
import cz.semprec.app.domain.NoteBlock
import cz.semprec.app.domain.NotePage
import cz.semprec.app.domain.NotePlacement
import cz.semprec.app.domain.NotesRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `GET /api/items/:id/page?format=summary`: the title and the blocks of a page. */
@Serializable
internal data class NotePageDto(val title: String = "", val blocks: List<NoteBlockDto> = emptyList())

@Serializable
internal data class NoteBlockDto(
    val id: String,
    val type: String = "text",
    val indent: Int = 0,
    val done: Boolean = false,
    val text: String = "",
    val pageId: String? = null,
)

/**
 * The page operations of the server (`/api/items/:id/page*`). A block type the app does not know is read as text, as
 * the block model says; the strict write side is the server's.
 */
class HttpNotesRepository(private val api: AuthenticatedApi) : NotesRepository {

    override suspend fun read(itemId: String): RepositoryResult<NotePage> =
        api.send(HttpMethod.Get, "/api/items/$itemId/page", listOf("format" to "summary")).decode<NotePageDto>()
            .map { dto -> NotePage(dto.title, dto.blocks.map { it.toBlock() }) }

    override suspend fun insert(itemId: String, placement: NotePlacement, markdown: String): RepositoryResult<Unit> {
        val body = buildJsonObject {
            put(
                "placement",
                when (placement) {
                    NotePlacement.Start -> JsonPrimitive("start")
                    NotePlacement.End -> JsonPrimitive("end")
                    is NotePlacement.After -> buildJsonObject { put("afterBlockId", placement.blockId) }
                },
            )
            put("markdown", markdown)
        }
        return post("/api/items/$itemId/page/insert", body)
    }

    override suspend fun createSubpage(
        itemId: String,
        afterBlockId: String?,
        title: String?,
        fromBlockIds: List<String>,
    ): RepositoryResult<Unit> {
        val body = buildJsonObject {
            if (fromBlockIds.isNotEmpty()) {
                put("fromBlockIds", JsonArray(fromBlockIds.map(::JsonPrimitive)))
            } else {
                afterBlockId?.let { put("afterBlockId", it) }
                title?.let { put("title", it) }
            }
        }
        return post("/api/items/$itemId/page/subpages", body)
    }

    override suspend fun convertToBlock(
        itemId: String,
        blockId: String,
        type: NoteBlockType,
        confirmedPageCount: Int,
    ): RepositoryResult<Unit> = post(
        "/api/items/$itemId/page/convert",
        buildJsonObject {
            put("blockId", blockId)
            put("type", type.wireName())
            put("confirmedPageCount", confirmedPageCount)
        },
    )

    override suspend fun rename(pageItemId: String, title: String): RepositoryResult<Unit> =
        api.send(
            HttpMethod.Patch,
            "/api/items/$pageItemId/page/title",
            body = buildJsonObject { put("title", title) }.toString(),
        ).ignoreBody()

    private suspend fun post(path: String, body: JsonObject): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, path, body = body.toString()).ignoreBody()
}

private fun NoteBlockDto.toBlock() = NoteBlock(
    id = id,
    type = when (type) {
        "h1" -> NoteBlockType.H1
        "h2" -> NoteBlockType.H2
        "h3" -> NoteBlockType.H3
        "bullet" -> NoteBlockType.BULLET
        "number" -> NoteBlockType.NUMBER
        "todo" -> NoteBlockType.TODO
        "quote" -> NoteBlockType.QUOTE
        "page" -> NoteBlockType.PAGE
        else -> NoteBlockType.TEXT
    },
    indent = indent,
    done = done,
    text = text,
    pageId = pageId,
)

private fun NoteBlockType.wireName(): String = name.lowercase()
