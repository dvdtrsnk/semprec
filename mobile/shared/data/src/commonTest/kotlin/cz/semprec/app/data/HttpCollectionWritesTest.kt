package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.PropertyOption
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private fun <T> RepositoryResult<T>.content(): T = assertIs<RepositoryResult.Content<T>>(this).value

class HttpCollectionWritesTest {
    private class Fixture(val reads: HttpCollectionReads, val writes: HttpCollectionWrites, val recorder: Recorder)

    private fun fixture(handler: Handler): Fixture {
        val recorder = Recorder { request ->
            if (request.url.encodedPath == "/api/schema") json(SCHEMA_JSON) else handler(request)
        }
        val reads = HttpCollectionReads(recorder.api)
        return Fixture(reads, HttpCollectionWrites(recorder.api, reads), recorder)
    }

    private suspend fun projects(fixture: Fixture): CollectionDatabase =
        fixture.reads.schema().content().database("projects")!!

    @Test
    fun anUpdateSendsTheVersionAndEveryValueInTheShapeOfItsProperty() = runTest {
        val f = fixture { json(PROJECT_JSON) }
        val projects = projects(f)
        val item = f.writes.update(
            projects,
            PROJECT_ITEM,
            "v1",
            mapOf(
                "name" to FieldValue.Text("Nový"),
                "status" to FieldValue.Choices(listOf("done")),
                "tags" to FieldValue.Choices(listOf("a", "b")),
                "pinned" to FieldValue.Flag(false),
                "budget" to FieldValue.Number(5.0),
                "date" to null,
                "unknown" to FieldValue.Text("x"),
            ),
        ).content()
        val request = f.recorder.requests.last()
        assertEquals(HttpMethod.Patch, request.method)
        assertEquals("/api/items/$PROJECT_ITEM", request.url.encodedPath)
        val body = f.recorder.bodyJson(1)
        assertEquals("v1", body.getValue("ifVersion").jsonPrimitive.content)
        val properties = body.getValue("properties").obj()
        assertEquals("Nový", properties.getValue("name").jsonPrimitive.content)
        assertEquals("done", properties.getValue("status").jsonPrimitive.content)
        assertEquals(listOf("a", "b"), properties.getValue("tags").jsonArray.map { it.jsonPrimitive.content })
        assertEquals("false", properties.getValue("pinned").jsonPrimitive.content)
        assertEquals("5.0", properties.getValue("budget").jsonPrimitive.content)
        assertEquals(JsonNull, properties.getValue("date"))
        assertEquals("x", properties.getValue("unknown").jsonPrimitive.content)
        assertEquals(PROJECT_ITEM, item.id)
    }

    @Test
    fun theVersionAnUpdateAnswersIsWhatTheNextUpdateSendsNotTheUpdatedAt() = runTest {
        val f = fixture { json(PROJECT_JSON) }
        val projects = projects(f)
        val first = f.writes.update(projects, PROJECT_ITEM, "2", mapOf("name" to FieldValue.Text("A"))).content()
        assertEquals("3", first.version)

        f.writes.update(projects, PROJECT_ITEM, first.version, mapOf("name" to FieldValue.Text("B")))

        val body = f.recorder.bodyJson(f.recorder.bodies.lastIndex)
        assertEquals("3", body.getValue("ifVersion").jsonPrimitive.content)
    }

    @Test
    fun aClearedSelectIsNullAndAConflictingVersionIsRejected() = runTest {
        val f = fixture { respond("", HttpStatusCode.Conflict) }
        val result = f.writes.update(
            projects(f), PROJECT_ITEM, "old",
            mapOf("status" to FieldValue.Choices(emptyList()))
        )
        assertEquals(JsonNull, f.recorder.bodyJson(1).getValue("properties").obj().getValue("status"))
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test
    fun creatingSendsTheTitleAndTheRelationItBelongsTo() = runTest {
        val f = fixture { json(PROJECT_JSON, HttpStatusCode.Created) }
        f.writes.create(projects(f), "Nový projekt", "area" to AREA_ITEM).content()
        val request = f.recorder.requests.last()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/databases/$PROJECTS_ID/items", request.url.encodedPath)
        val body = f.recorder.bodyJson(1)
        assertEquals("Nový projekt", body.getValue("properties").obj().getValue("name").jsonPrimitive.content)
        val relation = body.getValue("relations").jsonArray.single().obj()
        assertEquals("area", relation.getValue("propertyKey").jsonPrimitive.content)
        assertEquals(listOf(AREA_ITEM), relation.getValue("targetItemIds").jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun creatingWithoutARelationSendsNoneAndADatabaseWithoutATitleIsInvalid() = runTest {
        val f = fixture { json(PROJECT_JSON, HttpStatusCode.Created) }
        f.writes.create(projects(f), "X", null).content()
        assertTrue("relations" !in f.recorder.bodyJson(1))
        val bare = projects(f).copy(properties = emptyList())
        val result = f.writes.create(bare, "X", null)
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(result).kind)
        assertEquals(2, f.recorder.requests.size)
    }

    @Test
    fun relationsAreSetLinkedAndUnlinkedByTheirPropertyKey() = runTest {
        val f = fixture { json("{}") }
        f.writes.setRelation(PROJECT_ITEM, "area", AREA_ITEM).content()
        f.writes.setRelation(PROJECT_ITEM, "area", null).content()
        f.writes.link(PROJECT_ITEM, "people", "x").content()
        f.writes.unlinkEdge(PROJECT_ITEM, "people", "x").content()
        val requests = f.recorder.requests
        assertEquals(
            HttpMethod.Put to "/api/items/$PROJECT_ITEM/relations/area",
            requests[0].method to requests[0].url.encodedPath
        )
        assertEquals(AREA_ITEM, f.recorder.bodyJson(0).getValue("targetItemId").jsonPrimitive.content)
        assertEquals(JsonNull, f.recorder.bodyJson(1).getValue("targetItemId"))
        assertEquals(
            HttpMethod.Put to "/api/items/$PROJECT_ITEM/relations/people/x",
            requests[2].method to requests[2].url.encodedPath
        )
        assertEquals(
            HttpMethod.Delete to "/api/items/$PROJECT_ITEM/relations/people/x",
            requests[3].method to requests[3].url.encodedPath
        )
    }

    @Test
    fun aValueLinkIsEndedAndTakenOverThroughTheItemLinkEndpoints() = runTest {
        val f =
            fixture { json("""{"itemId":"i","propertyKey":"project","valueKind":"inheritedBroken","sources":[]}""") }
        f.writes.unlinkValue(PROJECT_ITEM, "status").content()
        f.writes.relinkValue(PROJECT_ITEM, "status").content()
        assertEquals(HttpMethod.Post, f.recorder.requests[0].method)
        assertEquals("/api/items/$PROJECT_ITEM/links/status/unlink", f.recorder.requests[0].url.encodedPath)
        assertEquals("/api/items/$PROJECT_ITEM/links/status/relink", f.recorder.requests[1].url.encodedPath)
    }

    @Test
    fun deletingAnItemAndAFailureOfIt() = runTest {
        val f = fixture { json("{}") }
        f.writes.delete(PROJECT_ITEM).content()
        assertEquals(HttpMethod.Delete, f.recorder.requests.single().method)
        val gone = fixture { respond("", HttpStatusCode.NotFound) }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(gone.writes.delete("x")).kind)
    }

    @Test
    fun aPageIsReplacedOnlyWhileItsEtagIsCurrent() = runTest {
        val f =
            fixture { respond("""{"trashedPages":[]}""", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"new\"")) }
        val page = f.writes.replacePage(PROJECT_ITEM, "# Nové", "old").content()
        val request = f.recorder.requests.single()
        assertEquals(HttpMethod.Put, request.method)
        assertEquals("/api/items/$PROJECT_ITEM/page.md", request.url.encodedPath)
        assertEquals("\"old\"", request.headers[HttpHeaders.IfMatch])
        assertEquals("# Nové", f.recorder.bodies.single().decodeToString())
        assertEquals("new", page.etag)
        assertEquals("# Nové", page.markdown)
    }

    @Test
    fun aStalePageIsRejectedAndAnAnswerWithoutAnEtagIsInvalid() = runTest {
        val stale = fixture { respond("", HttpStatusCode.Conflict) }
        val refused = stale.writes.replacePage("i", "x", "e")
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(refused).kind)
        val odd = fixture { respond("{}", HttpStatusCode.OK) }
        val unreadable = odd.writes.replacePage("i", "x", "e")
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(unreadable).kind)
    }

    @Test
    fun anUploadSendsTheRawBytesWithTheirTypeTheNameAndTheAttachment() = runTest {
        val file = """{"id":"$PROJECT_ITEM","databaseId":"$FILES_ID","properties":{"name":"a.pdf"},
            |"createdAt":"c","updatedAt":"u","version":"1"}
        """.trimMargin()
        val f = fixture { json(file, HttpStatusCode.Created) }
        val item = f.writes.upload(
            "a.pdf", "application/pdf", byteArrayOf(9, 8, 7),
            "projects" to PROJECT_ITEM
        ).content()
        val request = f.recorder.requests.single { it.url.encodedPath == "/api/files" }
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("application/pdf", request.body.contentType.toString())
        assertEquals("a.pdf", request.headers["X-Filename"])
        assertEquals(PROJECT_ITEM, request.headers["X-Attach-To-Item"])
        assertEquals("projects", request.headers["X-Attach-Relation"])
        assertEquals("Bearer tok", request.headers[HttpHeaders.Authorization])
        assertEquals(listOf<Byte>(9, 8, 7), f.recorder.bodies.first().toList())
        assertEquals(FieldValue.Text("a.pdf"), item.values["name"])
    }

    @Test
    fun anUploadWithoutAttachmentSendsNoAttachHeadersAndATooLargeFileIsInvalidData() = runTest {
        val f = fixture { respond("", HttpStatusCode.PayloadTooLarge) }
        val result = f.writes.upload("a.pdf", "application/pdf", byteArrayOf(1), null)
        val request = f.recorder.requests.single { it.url.encodedPath == "/api/files" }
        assertEquals(null, request.headers["X-Attach-To-Item"])
        assertEquals(null, request.headers["X-Attach-Relation"])
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test
    fun aNewOptionIsPostedByItsLabelToTheOptionsRouteOfItsProperty() = runTest {
        val f = fixture { json("""{"key":"client","label":"Client","color":"#FF9500"}""", HttpStatusCode.Created) }
        val tags = assertNotNull(projects(f).property("tags"))
        val option = f.writes.addOption(tags, "Client").content()
        val request = f.recorder.requests.last()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/properties/p7/options", request.url.encodedPath)
        assertEquals("Client", f.recorder.bodyJson(f.recorder.bodies.lastIndex).getValue("label").jsonPrimitive.content)
        assertEquals(PropertyOption("client", "Client", "#FF9500"), option)
    }

    @Test
    fun aRefusedNewOptionIsRejectedAndAnUnreadableAnswerIsInvalidData() = runTest {
        val refused = fixture { json("""{"error":"conflict"}""", HttpStatusCode.Conflict) }
        val tags = assertNotNull(projects(refused).property("tags"))
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(refused.writes.addOption(tags, "A")).kind)
        val unreadable = fixture { json("""{"label":"A"}""", HttpStatusCode.Created) }
        assertEquals(
            FailureKind.INVALID_DATA,
            assertIs<RepositoryResult.Failure>(unreadable.writes.addOption(tags, "A")).kind,
        )
    }
}
