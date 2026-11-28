package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SERVER = "https://s.example"
private const val TASKS_ID = "11111111-1111-4111-8111-111111111111"
private const val ITEM_ID = "22222222-2222-4222-8222-222222222222"

class ItemsApiTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun authenticated(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): AuthenticatedApi {
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession(SERVER, "tok")) }
        return AuthenticatedApi(ApiClient(engine), storage, onSessionRejected = {})
    }

    private fun items(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        ItemsApi(authenticated(handler))

    private fun writes(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        ItemWrites(authenticated(handler))

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun databasesFollowTheCursorAndTheKeysAreRemembered() = runTest {
        val api = items { request ->
            if (request.url.parameters["cursor"] == null) {
                json("""{"databases":[{"id":"$TASKS_ID","key":"tasks","name":"Tasks"}],"nextCursor":"c2"}""")
            } else {
                json("""{"databases":[{"id":"d2","key":"people","name":"People"},{"id":"d3","name":"Mine"}]}""")
            }
        }

        val all = assertIs<RepositoryResult.Content<List<DatabaseDto>>>(api.databases()).value
        assertEquals(listOf("tasks", "people", null), all.map { it.key })
        assertEquals(2, requests.size)
        assertEquals("c2", requests[1].url.parameters["cursor"])
        assertEquals("200", requests[0].url.parameters["limit"])

        assertEquals(TASKS_ID, assertIs<RepositoryResult.Content<String>>(api.databaseId("tasks")).value)
        assertEquals(2, requests.size, "A known key must not ask again")
    }

    @Test
    fun anUnknownKeyIsNotFoundAfterOneLookup() = runTest {
        val api = items { json("""{"databases":[]}""") }

        val result = api.databaseId("tasks")

        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(result).kind)
        assertEquals(1, requests.size)
    }

    @Test
    fun aFailedLookupIsThatFailure() = runTest {
        val api = items { json("""{}""", HttpStatusCode.ServiceUnavailable) }

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(api.databaseId("tasks")).kind)
    }

    @Test
    fun queryPostsTheFilterSortIncludeAndPaging() = runTest {
        val page = """{"items":[{"id":"$ITEM_ID","databaseId":"$TASKS_ID","properties":{"name":"A"}}]}"""
        val api = items { json(page) }
        val request = ItemQuery(
            filter = Filter.and(
                Filter.equals("status", "notDone"),
                RelationFilter.pathContains("project", "company", "c1"),
            ),
            sort = listOf("date" to "asc"),
            relations = mapOf("project" to listOf("company")),
            links = true,
            text = "faktura",
            limit = 50,
        )

        val answer = assertIs<RepositoryResult.Content<ItemPageDto>>(api.query(TASKS_ID, request)).value

        assertEquals("A", answer.items.single().properties.text("name"))
        assertEquals(HttpMethod.Post, requests.single().method)
        assertEquals("$SERVER/api/databases/$TASKS_ID/query", requests.single().url.toString().substringBefore("?"))
        assertEquals("Bearer tok", requests.single().headers[HttpHeaders.Authorization])
        val sent = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("and", sent.getValue("filter").jsonObject.getValue("type").jsonPrimitive.content)
        val sort = sent.getValue("sort").jsonArray.single().jsonObject
        assertEquals("date", sort.getValue("property").jsonPrimitive.content)
        val include = sent.getValue("include").jsonObject
        assertEquals("true", include.getValue("links").jsonPrimitive.content)
        val projection = include.getValue("relations").jsonObject.getValue("project").jsonArray
        assertEquals("company", projection.single().jsonPrimitive.content)
        assertEquals("faktura", sent.getValue("q").jsonPrimitive.content)
        assertEquals("50", sent.getValue("limit").jsonPrimitive.content)
    }

    @Test
    fun aPlainQuerySendsAnEmptyObject() = runTest {
        val api = items { json("""{"items":[]}""") }

        api.query(TASKS_ID, ItemQuery())

        assertEquals(JsonObject(emptyMap()), Json.parseToJsonElement(bodies.single()))
    }

    @Test
    fun queryAllFollowsThePagesUpToTheLimit() = runTest {
        var page = 0
        val api = items {
            page += 1
            val next = if (page < 5) "\"next$page\"" else "null"
            val two = """{"id":"i$page","databaseId":"d"},{"id":"j$page","databaseId":"d"}"""
            json("""{"items":[$two],"nextCursor":$next}""")
        }

        val result = api.queryAll(TASKS_ID, ItemQuery(), limit = 5)
        val all = assertIs<RepositoryResult.Content<List<ItemDto>>>(result).value

        assertEquals(listOf("i1", "j1", "i2", "j2", "i3"), all.map { it.id })
        assertEquals(3, requests.size, "The loop stops once the limit is reached")
        val second = Json.parseToJsonElement(bodies[1]).jsonObject
        assertEquals("next1", second.getValue("cursor").jsonPrimitive.content)
    }

    @Test
    fun getAsksForLinksAndTheNamedRelations() = runTest {
        val api = items {
            json(
                """{"id":"$ITEM_ID","databaseId":"$TASKS_ID","updatedAt":"2026-10-16T10:00:00Z","version":"8",
                "properties":{},
                "relations":{"project":[{"id":"p1","title":"Semprec iOS","color":"#007AFF"},{"id":"p2","hidden":true}]},
                "links":{"project":{"valueKind":"inherited",
                "sources":[{"kind":"item","itemId":"e1","title":"Standup"}]}}}""",
            )
        }

        val item = assertIs<RepositoryResult.Content<ItemDto>>(
            api.get(ITEM_ID, relations = mapOf("project" to emptyList(), "people" to listOf("name")), links = true),
        ).value

        val url = requests.single().url
        assertEquals("links,relations", url.parameters["include"])
        assertEquals("", url.parameters["relations.project"])
        assertEquals("name", url.parameters["relations.people"])
        assertEquals("Semprec iOS", item.relations.getValue("project")[0].title)
        assertTrue(item.relations.getValue("project")[1].hidden)
        assertEquals("inherited", item.links.getValue("project").valueKind)
        assertEquals("Standup", item.links.getValue("project").sources.single().title)
        assertEquals("8", item.version)
    }

    @Test
    fun getWithoutExtrasAsksForNothingMore() = runTest {
        val api = items { json("""{"id":"$ITEM_ID","databaseId":"$TASKS_ID"}""") }

        api.get(ITEM_ID)

        assertNull(requests.single().url.parameters["include"])
    }

    @Test
    fun patchSendsThePropertiesAndTheVersionAndAStaleVersionIsRejected() = runTest {
        val api = writes { json("""{"error":{"code":"conflict"}}""", HttpStatusCode.Conflict) }

        val result = api.patch(ITEM_ID, buildJsonObject { put("status", "done") }, "v1")

        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
        assertEquals(HttpMethod.Patch, requests.single().method)
        val sent = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("v1", sent.getValue("ifVersion").jsonPrimitive.content)
        assertEquals("done", sent.getValue("properties").jsonObject.getValue("status").jsonPrimitive.content)
    }

    @Test
    fun createSendsThePropertiesAndTheRelations() = runTest {
        val api = writes { json("""{"id":"$ITEM_ID","databaseId":"$TASKS_ID"}""", HttpStatusCode.Created) }

        val result = api.create(TASKS_ID, buildJsonObject { put("name", "A") }, mapOf("project" to listOf("p1")))

        assertEquals(ITEM_ID, assertIs<RepositoryResult.Content<ItemDto>>(result).value.id)
        val sent = Json.parseToJsonElement(bodies.single()).jsonObject
        val relation = sent.getValue("relations").jsonArray.single().jsonObject
        assertEquals("project", relation.getValue("propertyKey").jsonPrimitive.content)
        assertEquals("p1", relation.getValue("targetItemIds").jsonArray.single().jsonPrimitive.content)
    }

    @Test
    fun deleteAndTheRelationCallsUseTheirRoutes() = runTest {
        val api = writes { json("""{}""") }

        api.delete(ITEM_ID)
        api.setRelation(ITEM_ID, "project", "p1")
        api.setRelation(ITEM_ID, "project", null)
        api.addRelation(ITEM_ID, "people", "q1")
        api.removeRelation(ITEM_ID, "people", "q1")
        api.changeValueLink(ITEM_ID, "project", relink = false)
        api.changeValueLink(ITEM_ID, "project", relink = true)

        val routes = requests.map { "${it.method.value} ${it.url.encodedPath}" }
        assertEquals(
            listOf(
                "DELETE /api/items/$ITEM_ID",
                "PUT /api/items/$ITEM_ID/relations/project",
                "PUT /api/items/$ITEM_ID/relations/project",
                "PUT /api/items/$ITEM_ID/relations/people/q1",
                "DELETE /api/items/$ITEM_ID/relations/people/q1",
                "POST /api/items/$ITEM_ID/links/project/unlink",
                "POST /api/items/$ITEM_ID/links/project/relink",
            ),
            routes,
        )
        val set = Json.parseToJsonElement(bodies[1]).jsonObject
        assertEquals("p1", set.getValue("targetItemId").jsonPrimitive.content)
        val cleared = Json.parseToJsonElement(bodies[2]).jsonObject
        assertEquals("null", cleared.getValue("targetItemId").toString())
    }

    @Test
    fun anUnreadableAnswerIsInvalidData() = runTest {
        val api = items { json("""{"items":"no"}""") }

        val result = api.query(TASKS_ID, ItemQuery())

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(result).kind)
    }
}
