package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.NoteBlockType
import cz.semprec.app.domain.NotePage
import cz.semprec.app.domain.NotePlacement
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

private const val PAGE = """{"docId":"d1","kind":"page","title":"Notes","blockCount":9,"subpageCount":1,
    "blocks":[
    {"id":"b1","type":"h1","indent":0,"done":false,"text":"Plan"},
    {"id":"b2","type":"text","indent":0,"done":false,"text":"Some **bold** text"},
    {"id":"b3","type":"bullet","indent":1,"done":false,"text":"point"},
    {"id":"b4","type":"number","indent":0,"done":false,"text":"first"},
    {"id":"b5","type":"todo","indent":0,"done":true,"text":"done"},
    {"id":"b6","type":"quote","indent":0,"done":false,"text":"q"},
    {"id":"b7","type":"page","indent":0,"done":false,"text":"Sub","pageId":"p1"},
    {"id":"b8","type":"h2","indent":0,"done":false,"text":"two"},
    {"id":"b9","type":"h3","indent":2,"done":false,"text":"three"},
    {"id":"b10","type":"future","indent":0,"done":false,"text":"strange"}],
    "headings":[],"lastEditedAt":null,"lastEditedBy":null}"""

class HttpNotesRepositoryTest {
    private fun recorder(status: HttpStatusCode = HttpStatusCode.OK, body: String = "{}") =
        Recorder { json(body, status) }

    @Test
    fun aPageIsReadAsTheSummaryWithEveryBlockType() = runTest {
        val recorder = recorder(body = PAGE)

        val page = assertIs<RepositoryResult.Content<NotePage>>(HttpNotesRepository(recorder.api).read("i1")).value

        val request = recorder.requests.single()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("/api/items/i1/page", request.url.encodedPath)
        assertEquals("summary", request.url.parameters["format"])
        assertEquals("Notes", page.title)
        assertEquals(
            listOf(
                NoteBlockType.H1, NoteBlockType.TEXT, NoteBlockType.BULLET, NoteBlockType.NUMBER, NoteBlockType.TODO,
                NoteBlockType.QUOTE, NoteBlockType.PAGE, NoteBlockType.H2, NoteBlockType.H3, NoteBlockType.TEXT,
            ),
            page.blocks.map { it.type },
        )
        assertEquals(listOf(0, 0, 1), page.blocks.take(3).map { it.indent })
        assertEquals("Some **bold** text", page.blocks[1].text)
        assertEquals(true, page.blocks[4].done)
        assertEquals("p1", page.blocks[6].pageId)
        assertEquals(null, page.blocks[0].pageId)
    }

    @Test
    fun anEmptyPageHasNoBlocksAndAnAnswerThatIsNoPageIsInvalidData() = runTest {
        val empty = assertIs<RepositoryResult.Content<NotePage>>(
            HttpNotesRepository(recorder(body = """{"title":"Notes","blocks":[]}""").api).read("i1"),
        ).value
        val broken = HttpNotesRepository(recorder(body = "[]").api).read("i1")

        assertTrue(empty.blocks.isEmpty())
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), broken)
    }

    @Test
    fun markdownIsInsertedAtTheStartTheEndOrAfterABlock() = runTest {
        val placements = listOf(
            NotePlacement.Start to JsonPrimitive("start"),
            NotePlacement.End to JsonPrimitive("end"),
            NotePlacement.After("b3") to JsonObject(mapOf("afterBlockId" to JsonPrimitive("b3"))),
        )
        for ((placement, wire) in placements) {
            val recorder = recorder()

            assertIs<RepositoryResult.Content<Unit>>(HttpNotesRepository(recorder.api).insert("i1", placement, "- x"))

            assertEquals(HttpMethod.Post, recorder.requests.single().method)
            assertEquals("/api/items/i1/page/insert", recorder.requests.single().url.encodedPath)
            assertEquals(wire, recorder.bodyJson().getValue("placement"))
            assertEquals(JsonPrimitive("- x"), recorder.bodyJson().getValue("markdown"))
            assertEquals(setOf("placement", "markdown"), recorder.bodyJson().keys)
        }
    }

    @Test
    fun anEmptySubpageIsMadeAfterABlockWithATitle() = runTest {
        val recorder = recorder()

        HttpNotesRepository(recorder.api).createSubpage("i1", "b2", "Ideas", emptyList())

        assertEquals("/api/items/i1/page/subpages", recorder.requests.single().url.encodedPath)
        assertEquals(
            JsonObject(mapOf("afterBlockId" to JsonPrimitive("b2"), "title" to JsonPrimitive("Ideas"))),
            recorder.bodyJson(),
        )
    }

    @Test
    fun aSubpageWithoutAPlaceOrATitleSendsAnEmptyObject() = runTest {
        val recorder = recorder()

        HttpNotesRepository(recorder.api).createSubpage("i1", null, null, emptyList())

        assertEquals(JsonObject(emptyMap()), recorder.bodyJson())
    }

    @Test
    fun blocksMovedIntoSubpagesSendOnlyTheirIds() = runTest {
        val recorder = recorder()

        HttpNotesRepository(recorder.api).createSubpage("i1", "b2", "Ignored", listOf("b1", "b3"))

        assertEquals(
            JsonObject(mapOf("fromBlockIds" to JsonArray(listOf(JsonPrimitive("b1"), JsonPrimitive("b3"))))),
            recorder.bodyJson(),
        )
    }

    @Test
    fun aSubpageBlockIsConvertedWithTheTypeAsItsWireNameAndTheCountShown() = runTest {
        for (type in NoteBlockType.entries.filter { it != NoteBlockType.PAGE }) {
            val recorder = recorder()

            HttpNotesRepository(recorder.api).convertToBlock("i1", "b7", type, 2)

            assertEquals("/api/items/i1/page/convert", recorder.requests.single().url.encodedPath)
            assertEquals(
                JsonObject(
                    mapOf(
                        "blockId" to JsonPrimitive("b7"),
                        "type" to JsonPrimitive(type.name.lowercase()),
                        "confirmedPageCount" to JsonPrimitive(2),
                    ),
                ),
                recorder.bodyJson(),
            )
        }
    }

    @Test
    fun aSubpageIsRenamedOnItsOwnPath() = runTest {
        val recorder = recorder()

        HttpNotesRepository(recorder.api).rename("p1", "New")

        assertEquals(HttpMethod.Patch, recorder.requests.single().method)
        assertEquals("/api/items/p1/page/title", recorder.requests.single().url.encodedPath)
        assertEquals(JsonObject(mapOf("title" to JsonPrimitive("New"))), recorder.bodyJson())
    }

    @Test
    fun everyWriteReportsARefusalAndAConflictAsAFailureOfItsKind() = runTest {
        val rejected = HttpNotesRepository(recorder(HttpStatusCode.BadRequest).api)
        val conflict = HttpNotesRepository(recorder(HttpStatusCode.Conflict).api)
        val gone = HttpNotesRepository(recorder(HttpStatusCode.NotFound).api)

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), rejected.insert("i1", NotePlacement.End, "x"))
        val converted = conflict.convertToBlock("i1", "b", NoteBlockType.TEXT, 1)
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), converted)
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.rename("p1", "x"))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.createSubpage("i1", null, null, emptyList()))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.read("i1"))
    }
}
