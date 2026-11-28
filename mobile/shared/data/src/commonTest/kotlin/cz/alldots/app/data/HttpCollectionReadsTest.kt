package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.Author
import cz.alldots.app.domain.CollectionPage
import cz.alldots.app.domain.CollectionQuery
import cz.alldots.app.domain.CollectionScope
import cz.alldots.app.domain.FacetSelection
import cz.alldots.app.domain.FieldValue
import cz.alldots.app.domain.FilterTree
import cz.alldots.app.domain.PropertyKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SortSpec
import cz.alldots.app.domain.ValueKind
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun <T> RepositoryResult<T>.content(): T = assertIs<RepositoryResult.Content<T>>(this).value

class HttpCollectionReadsTest {
    private fun reads(handler: Handler): Pair<HttpCollectionReads, Recorder> {
        val recorder = Recorder(handler)
        return HttpCollectionReads(recorder.api) to recorder
    }

    /** Answers the schema request with the fixture schema and every other request with [body]. */
    private fun schemaAnd(body: String): Handler = { request ->
        if (request.url.encodedPath == "/api/schema") json(SCHEMA_JSON) else json(body)
    }

    @Test
    fun theSchemaDescribesEveryDatabaseWithItsPropertiesAndViewHints() = runTest {
        val (reads, recorder) = reads { json(SCHEMA_JSON) }
        val schema = reads.schema().content()
        assertEquals("2026-10-16", schema.today)
        val projects = assertNotNull(schema.database("projects"))
        assertEquals("Projekty", projects.name)
        assertEquals("Hledat v projektech", projects.searchPlaceholder)
        assertEquals(listOf("active", "all"), projects.quickFilters.map { it.key })
        assertTrue(projects.quickFilters.first().isDefault)
        assertEquals(listOf(SortSpec("date", null, false)), projects.quickFilters.last().sort)
        assertEquals(SortSpec(null, "createdAt", true), projects.defaultSort)
        assertEquals("Po termínu", projects.dateLabels?.past)
        assertNotNull(projects.collectionFilter)
        assertEquals("name", projects.title?.key)
        val kinds = projects.properties.associate { it.key to it.kind }
        assertEquals(PropertyKind.SELECT, kinds["status"])
        assertEquals(PropertyKind.RELATION, kinds["company"])
        assertEquals(PropertyKind.OTHER, kinds["recurrence"])
        assertEquals(COMPANIES_ID, projects.property("company")?.targetDatabaseId)
        assertEquals("#007AFF", projects.property("status")?.options?.first()?.color)
        assertTrue(projects.property("completedAt")!!.system)
        assertEquals("tags", projects.facetBarProperty)
        assertNull(schema.database("companies")?.facetBarProperty)
        assertEquals("/api/schema", recorder.requests.single().url.encodedPath)
        assertEquals("Bearer tok", recorder.requests.single().headers[HttpHeaders.Authorization])
    }

    @Test
    fun theSchemaIsKeptForTheSessionAndReadAgainForAnother() = runTest {
        val (reads, recorder) = reads { json(SCHEMA_JSON) }
        reads.schema()
        reads.schema()
        assertEquals(1, recorder.requests.size)
        recorder.storage.save(StoredSession("https://s.example", "other"))
        reads.schema()
        assertEquals(2, recorder.requests.size)
        reads.refreshSchema()
        assertEquals(3, recorder.requests.size)
    }

    @Test
    fun anUnreadableSchemaIsInvalidDataAndAnUnavailableServerIsUnavailable() = runTest {
        val (broken, _) = reads { json("""{"unexpected": true}""") }
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(broken.schema()).kind)
        val (down, _) = reads { respond("", HttpStatusCode.BadGateway) }
        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(down.schema()).kind)
    }

    @Test
    fun aQueryAndsTheCollectionFilterTheScopeTheChipAndTheSelectionsAndAsksForLinksAndRelations() = runTest {
        val (reads, recorder) = reads(schemaAnd("""{"items": [], "nextCursor": null}"""))
        val projects = reads.schema().content().database("projects")!!
        val chip = projects.quickFilters.first()
        val query = CollectionQuery(
            scope = CollectionScope.Related("company", COMPANY_ITEM),
            quickFilter = chip.filter,
            selections = listOf(
                FacetSelection.OneOf("status", listOf("done", "inProgress")),
                FacetSelection.OneOf("company", listOf(COMPANY_ITEM, "x")),
                FacetSelection.DatePreset("date", "thisWeek"),
                FacetSelection.Checked("pinned", true),
                FacetSelection.OneOf("tags", emptyList()),
            ),
            search = "web",
            sort = listOf(SortSpec("name", null, false), SortSpec(null, "createdAt", true)),
            cursor = "c1",
            limit = 20,
            expand = listOf("company"),
        )
        reads.query(projects, query).content()

        val request = recorder.requests.last()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/databases/$PROJECTS_ID/query", request.url.encodedPath)
        val body = recorder.bodyJson(1)
        val filter = body.getValue("filter").obj()
        assertEquals("and", filter.getValue("type").jsonPrimitive.content)
        val nodes = filter.getValue("nodes").jsonArray.map { it.obj() }
        assertEquals(
            listOf("is_empty", "relation_contains", "in", "in", "or", "date_relative", "equals"),
            nodes.map { it.getValue("type").jsonPrimitive.content },
        )
        assertEquals("company", nodes[1].getValue("property").jsonPrimitive.content)
        assertEquals(COMPANY_ITEM, nodes[1].getValue("value").jsonPrimitive.content)
        assertEquals(
            listOf("done", "inProgress"),
            nodes[3].getValue("value").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals(2, nodes[4].getValue("nodes").jsonArray.size)
        assertEquals("thisWeek", nodes[5].getValue("preset").jsonPrimitive.content)
        assertTrue(nodes[6].getValue("value").jsonPrimitive.boolean)
        assertEquals("web", body.getValue("q").jsonPrimitive.content)
        assertEquals("c1", body.getValue("cursor").jsonPrimitive.content)
        assertEquals(20, body.getValue("limit").jsonPrimitive.int)
        val sort = body.getValue("sort").jsonArray.map { it.obj() }
        assertEquals("name", sort[0].getValue("property").jsonPrimitive.content)
        assertEquals("asc", sort[0].getValue("direction").jsonPrimitive.content)
        assertEquals("createdAt", sort[1].getValue("system").jsonPrimitive.content)
        assertEquals("desc", sort[1].getValue("direction").jsonPrimitive.content)
        val include = body.getValue("include").obj()
        assertTrue(include.getValue("links").jsonPrimitive.boolean)
        assertTrue(include.getValue("derived").jsonPrimitive.boolean)
        assertEquals(JsonArray(emptyList()), include.getValue("relations").obj().getValue("company"))
    }

    @Test
    fun aQueryWithNothingToNarrowByAsksForNoFilterAndASingleConditionIsNotWrapped() = runTest {
        val (reads, recorder) = reads(schemaAnd("""{"items": []}"""))
        val schema = reads.schema().content()
        reads.query(schema.database("companies")!!, CollectionQuery()).content()
        assertNull(recorder.bodyJson(1)["filter"])
        assertNull(recorder.bodyJson(1)["q"])
        assertNull(recorder.bodyJson(1)["sort"])
        reads.query(
            schema.database("files")!!,
            CollectionQuery(
                scope = CollectionScope.Related(
                    "projects",
                    PROJECT_ITEM
                )
            )
        )
        val filter = recorder.bodyJson(2).getValue("filter").obj()
        assertEquals("relation_contains", filter.getValue("type").jsonPrimitive.content)
        assertEquals("projects", filter.getValue("property").jsonPrimitive.content)
        assertEquals(PROJECT_ITEM, filter.getValue("value").jsonPrimitive.content)
    }

    @Test
    fun aMatchingScopePassesTheRelatedCollectionsFilterOn() = runTest {
        val (reads, recorder) = reads(schemaAnd("""{"items": []}"""))
        val files = reads.schema().content().database("files")!!
        val filter = FilterTree("""{"type":"relation_contains","property":"projects","value":"p"}""")
        reads.query(files, CollectionQuery(scope = CollectionScope.Matching(filter)))
        assertEquals("p", recorder.bodyJson(1).getValue("filter").obj().getValue("value").jsonPrimitive.content)
    }

    @Test
    fun aQueryPageDecodesEveryValueByItsPropertyKind() = runTest {
        val (reads, _) = reads(schemaAnd("""{"items": [$PROJECT_JSON], "nextCursor": "next"}"""))
        val projects = reads.schema().content().database("projects")!!
        val page: CollectionPage = reads.query(projects, CollectionQuery()).content()
        assertEquals("next", page.nextCursor)
        val item = page.items.single()
        assertEquals(FieldValue.Text("Alldots iOS"), item.values["name"])
        assertEquals(FieldValue.Choices(listOf("inProgress")), item.values["status"])
        assertEquals(FieldValue.Text("2027-01-31"), item.values["date"])
        assertEquals(FieldValue.Flag(true), item.values["pinned"])
        assertEquals(FieldValue.Choices(listOf("a", "b")), item.values["tags"])
        assertEquals(FieldValue.Number(180000.0), item.values["budget"])
        assertNull(item.values["recurrence"])
        assertEquals("3", item.version)
    }

    @Test
    fun relationTargetsComeFromTheExpandedRelationsAndTheDerivedCompanyOverridesThem() = runTest {
        val (reads, _) = reads(schemaAnd(PROJECT_JSON))
        reads.schema()
        val item = reads.item(PROJECT_ITEM, listOf("company")).content()
        val targets = assertIs<FieldValue.Targets>(item.values["company"]).targets
        assertEquals(listOf("Novák Web s.r.o."), targets.map { it.title })
        assertEquals("companies", targets.single().databaseKey)
    }

    @Test
    fun valueOriginsAreTheLinksOfTheItemAndTheDerivedValues() = runTest {
        val (reads, _) = reads(schemaAnd(PROJECT_JSON))
        val item = reads.item(PROJECT_ITEM, emptyList()).content()
        val status = assertNotNull(item.origins["status"])
        assertEquals(ValueKind.INHERITED, status.kind)
        assertEquals("Odeslat fakturu", status.sources.single().title)
        assertEquals("t1", status.sources.single().itemId)
        assertEquals("tasks", status.sources.single().databaseKey)
        val date = assertNotNull(item.origins["date"])
        assertEquals(ValueKind.INHERITED_BROKEN, date.kind)
        assertEquals(Author.AGENT, date.brokenBy)
        assertEquals("novak-web.cz", date.sources.single().title)
        val company = assertNotNull(item.origins["company"])
        assertEquals(ValueKind.DERIVED, company.kind)
        assertEquals(PROJECT_ITEM, company.sources.single().itemId)
        assertNull(item.origins["name"])
    }

    @Test
    fun anItemIsReadWithLinksDerivedValuesAndTheNamedRelations() = runTest {
        val (reads, recorder) = reads(schemaAnd(PROJECT_JSON))
        reads.item(PROJECT_ITEM, listOf("company", "people")).content()
        val request = recorder.requests.last()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("/api/items/$PROJECT_ITEM", request.url.encodedPath)
        assertEquals("links,derived,relations", request.url.parameters["include"])
        assertEquals("", request.url.parameters["relations.company"])
        assertEquals("", request.url.parameters["relations.people"])
    }

    @Test
    fun anItemOfADatabaseTheSchemaLacksIsInvalidDataAndAMissingItemIsNotFound() = runTest {
        val (strange, _) = reads(schemaAnd("""{"id":"i","databaseId":"unknown"}"""))
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(strange.item("i", emptyList())).kind)
        val (missing, _) = reads { request ->
            if (request.url.encodedPath == "/api/schema") json(SCHEMA_JSON) else respond("", HttpStatusCode.NotFound)
        }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(missing.item("i", emptyList())).kind)
    }

    @Test
    fun relatedCollectionsKeepTheirFilterAndAThreadsRowHasNone() = runTest {
        val (reads, recorder) = reads {
            json(
                """[{"databaseKey":"files","databaseId":"$FILES_ID","count":3,"via":"direct",
                    "filter":{"type":"relation_contains","property":"projects","value":"$PROJECT_ITEM"}},
                   {"databaseKey":"threads","databaseId":"t","count":1,"via":"direct","filter":null}]""",
            )
        }
        val related = reads.related(PROJECT_ITEM).content()
        assertEquals("/api/items/$PROJECT_ITEM/related", recorder.requests.single().url.encodedPath)
        assertEquals(listOf(3, 1), related.map { it.count })
        assertTrue(assertNotNull(related.first().filter).json.contains("relation_contains"))
        assertNull(related.last().filter)
    }

    @Test
    fun facetsAreRequestedByPropertyAndDecodedWithTheirCounts() = runTest {
        val (reads, recorder) = reads { request ->
            if (request.url.encodedPath == "/api/schema") {
                json(SCHEMA_JSON)
            } else {
                json(
                    """{"facets":[{"property":"status","all":5,"values":[
                        {"value":"inProgress","label":"Probíhá","color":"#007AFF","count":3},
                        {"value":null,"count":2}]},{"path":["a","b"],"all":0,"values":[]}]}""",
                )
            }
        }
        val projects = reads.schema().content().database("projects")!!
        val facets = reads.facets(projects, CollectionQuery(), listOf("status")).content()
        assertEquals("/api/databases/$PROJECTS_ID/facets", recorder.requests.last().url.encodedPath)
        assertEquals(
            listOf("status"),
            recorder.bodyJson(1).getValue("facets").jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals(listOf("status"), facets.map { it.propertyKey })
        assertEquals("inProgress", facets.single().values.first().value)
        assertEquals(3, facets.single().values.first().count)
        assertNull(facets.single().values.last().value)
    }

    @Test
    fun theDeleteImpactIsDecodedAndAPageCarriesItsEtag() = runTest {
        val (reads, _) = reads { request ->
            when {
                request.url.encodedPath.endsWith("/delete-impact") -> json(
                    """{"related":[{"databaseKey":"files","count":2}],"subtreeItemCount":4,"subtreePageCount":1,
                        "linksToOwn":[{"itemId":"i","propertyKey":"project"}],"seriesInstanceCount":0,
                        "attachmentCount":2,"hostEventCount":1}""",
                )
                else -> respond("# Poznámky", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"abc\""))
            }
        }
        val impact = reads.deleteImpact(PROJECT_ITEM).content()
        assertEquals(listOf("files" to 2), impact.related.map { it.databaseKey to it.count })
        assertEquals(4, impact.nestedItems)
        assertEquals(1, impact.nestedPages)
        assertEquals(1, impact.takenOverValues)
        assertEquals(2, impact.attachments)
        assertEquals(1, impact.hostEvents)
        val page = reads.page(PROJECT_ITEM).content()
        assertEquals("# Poznámky", page.markdown)
        assertEquals("abc", page.etag)
    }

    @Test
    fun aPageWithoutAnEtagIsInvalidData() = runTest {
        val (reads, _) = reads { respond("text", HttpStatusCode.OK) }
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(reads.page("i")).kind)
    }

    @Test
    fun aBlobIsDownloadedWithItsMediaTypeAndAMissingOneIsNotFound() = runTest {
        val (reads, recorder) = reads { request ->
            if (request.url.encodedPath.endsWith("missing")) {
                respond("", HttpStatusCode.NotFound)
            } else {
                respond(
                    byteArrayOf(1, 2, 3), HttpStatusCode.OK,
                    headersOf(
                        HttpHeaders.ContentType,
                        "image/png; charset=binary"
                    )
                )
            }
        }
        val blob = reads.blob("b1").content()
        assertEquals("image/png", blob.mimeType)
        assertEquals(listOf<Byte>(1, 2, 3), blob.bytes.toList())
        assertEquals("/api/blobs/b1", recorder.requests.single().url.encodedPath)
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(reads.blob("missing")).kind)
    }

    @Test
    fun aRejectedSessionOnABlobDownloadSignsOut() = runTest {
        val (reads, recorder) = reads { respond("", HttpStatusCode.Unauthorized) }
        assertEquals(FailureKind.UNAUTHORIZED, assertIs<RepositoryResult.Failure>(reads.blob("b1")).kind)
        assertEquals(1, recorder.rejected)
    }

    @Test
    fun aNumberStoredAsTextAndAnUnknownShapeShowAsEmpty() = runTest {
        val (reads, _) = reads { request ->
            if (request.url.encodedPath == "/api/schema") {
                json(SCHEMA_JSON)
            } else {
                json(
                    """{"id":"i","databaseId":"$PROJECTS_ID","createdAt":"c","updatedAt":"u","version":"1",
                        "properties":{"budget":"lots","status":5,"pinned":"yes","tags":"a","date":null,"name":"N"}}""",
                )
            }
        }
        val item = reads.item("i", emptyList()).content()
        assertEquals(setOf("name"), item.values.keys)
    }
}
