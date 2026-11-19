package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.note.NotePageInfo
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

private const val SUMMARY = """{"docId":"d1","kind":"page","title":"Notes","blocks":[
    {"id":"b1","type":"h1","indent":0,"done":false,"text":"Plan"},
    {"id":"b2","type":"page","indent":0,"done":false,"text":"Trip","pageId":"p9"}],
    "headings":[],"lastEditedAt":"2026-11-19T08:00:00.000Z","lastEditedBy":null}"""

class HttpNotePageRepositoryTest {
    private fun repository(recorder: Recorder) =
        HttpNotePageRepository(recorder.api, HttpJournalRepository(recorder.api))

    @Test
    fun theSummaryGivesTheTitleTheServerBlockIdsInOrderAndTheLastEdit() = runTest {
        val recorder = Recorder { json(SUMMARY) }

        val info = repository(recorder).info("i1")

        assertEquals(
            RepositoryResult.Content(NotePageInfo("Notes", listOf("b1", "b2"), "2026-11-19T08:00:00.000Z")),
            info,
        )
        assertEquals(HttpMethod.Get, recorder.requests.single().method)
        assertEquals("/api/items/i1/page", recorder.requests.single().url.encodedPath)
    }

    @Test
    fun aSubpageIsMadeFromTheNamedBlockOfItsParent() = runTest {
        val recorder = Recorder { json("{}", HttpStatusCode.Created) }

        val made = repository(recorder).subpageFromBlock("i1", "b2")

        assertEquals(RepositoryResult.Content(Unit), made)
        assertEquals(HttpMethod.Post, recorder.requests.single().method)
        assertEquals("/api/items/i1/page/subpages", recorder.requests.single().url.encodedPath)
        assertEquals(JsonObject(mapOf("fromBlockIds" to JsonArray(listOf(JsonPrimitive("b2"))))), recorder.bodyJson())
    }

    @Test
    fun aSubpageIsCopiedAndRenamedThroughItsOwnItem() = runTest {
        val recorder = Recorder { json("{}") }

        repository(recorder).duplicateSubpage("p9")
        repository(recorder).rename("p9", "Trip 2")

        assertEquals(
            listOf(HttpMethod.Post to "/api/items/p9/page/duplicate", HttpMethod.Patch to "/api/items/p9/page/title"),
            recorder.requests.map { it.method to it.url.encodedPath },
        )
        assertEquals(JsonObject(mapOf("title" to JsonPrimitive("Trip 2"))), recorder.bodyJson(1))
    }

    @Test
    fun aRefusedOperationIsAFailureWithItsKind() = runTest {
        val recorder = Recorder { json("""{"error":"not found"}""", HttpStatusCode.NotFound) }

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), repository(recorder).duplicateSubpage("p9"))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), repository(recorder).info("i1"))
    }
}
