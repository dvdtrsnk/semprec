package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.Overview
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val OVERVIEW_AREAS_ID = "aaaaaaaa-0000-4000-8000-000000000001"
private const val OVERVIEW_PROJECTS_ID = "aaaaaaaa-0000-4000-8000-000000000002"
private const val EVENTS_ID = "aaaaaaaa-0000-4000-8000-000000000003"
private const val GONE_ID = "aaaaaaaa-0000-4000-8000-000000000004"

private const val OVERVIEW = """{"inboxPending":9,"mailUnread":5,"tasksToday":4,"problemCount":2,
    "journalTodayItemId":"j1",
    "areas":[{"id":"area-work","activeProjectCount":6}],
    "collections":[{"databaseId":"$EVENTS_ID","ownerModuleId":"events","itemCount":214},
    {"databaseId":"$GONE_ID","ownerModuleId":"people","itemCount":3}]}"""

private const val DATABASES = """{"databases":[
    {"id":"$OVERVIEW_AREAS_ID","key":"areas","name":"Areas"},
    {"id":"$OVERVIEW_PROJECTS_ID","key":"projects","name":"Projects"},
    {"id":"$EVENTS_ID","key":"events","name":"Events","icon":"calendar","color":"#FF3B30","overviewOrder":2,
    "clientVisible":true,"overviewHidden":false}]}"""

private const val AREAS = """{"items":[
    {"id":"area-work","databaseId":"$OVERVIEW_AREAS_ID","properties":{"name":"Work","color":"#5856D6","icon":"briefcase","position":1}},
    {"id":"area-old","databaseId":"$OVERVIEW_AREAS_ID","properties":{"name":"Old","active":false}}]}"""

private const val PROJECTS = """{"items":[
    {"id":"p1","databaseId":"$OVERVIEW_PROJECTS_ID","properties":{"name":"Semprec iOS","pinned":true,"pinnedOrder":1,
    "status":"inProgress","color":"#007AFF"},"relations":{"area":[{"id":"area-work","title":"Work"}]}}]}"""

class HttpOverviewRepositoryTest {
    private val paths = mutableListOf<String>()
    private val bodies = mutableListOf<String>()

    private fun repository(
        overview: String = OVERVIEW,
        handler: (HttpRequestData) -> String? = { null },
    ): HttpOverviewRepository {
        val engine = MockEngine { request ->
            paths += request.url.encodedPath
            bodies += request.body.toByteArray().decodeToString()
            handler(request)?.let { return@MockEngine json(it, HttpStatusCode.ServiceUnavailable) }
            when (request.url.encodedPath) {
                "/api/overview" -> json(overview)
                "/api/databases" -> json(DATABASES)
                "/api/databases/$OVERVIEW_AREAS_ID/query" -> json(AREAS)
                "/api/databases/$OVERVIEW_PROJECTS_ID/query" -> json(PROJECTS)
                else -> json("{}", HttpStatusCode.NotFound)
            }
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        return HttpOverviewRepository(AuthenticatedApi(ApiClient(engine), storage, onSessionRejected = {}))
    }

    private fun MockRequestHandleScope.json(
        body: String,
        status: HttpStatusCode = HttpStatusCode.OK,
    ): HttpResponseData =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun theOverviewJoinsTheCountsTheDatabasesTheAreasAndThePinnedProjects() = runTest {
        val result = repository().load()

        val overview = assertIs<RepositoryResult.Content<Overview>>(result).value
        assertEquals(9, overview.summary.inboxPending)
        assertEquals(5, overview.summary.mailUnread)
        assertEquals(4, overview.summary.tasksToday)
        assertEquals(2, overview.summary.problemCount)
        assertEquals("j1", overview.summary.journalTodayItemId)
        assertEquals(listOf("area-work", "area-old"), overview.areas.map { it.id })
        assertEquals(6, overview.areas[0].activeProjectCount)
        assertEquals("briefcase", overview.areas[0].icon)
        assertEquals(1.0, overview.areas[0].position)
        assertTrue(overview.areas[0].active)
        assertEquals(0, overview.areas[1].activeProjectCount)
        assertEquals(false, overview.areas[1].active)
        val project = overview.projects.single()
        assertEquals("Semprec iOS", project.name)
        assertEquals("Work", project.areaName)
        assertEquals("inProgress", project.status)
        assertEquals(1.0, project.pinnedOrder)
        val collection = overview.collections.single()
        assertEquals("Events", collection.name)
        assertEquals(214, collection.itemCount)
        assertEquals("events", collection.ownerModuleId)
        assertEquals(2, collection.order)
        assertEquals("calendar", collection.icon)
    }

    @Test
    fun aCollectionWithoutADatabaseEntryIsLeftOut() = runTest {
        val overview = assertIs<RepositoryResult.Content<Overview>>(repository().load()).value

        assertTrue(overview.collections.none { it.databaseId == GONE_ID })
    }

    @Test
    fun theProjectsAreQueriedForPinnedOnesWithTheirArea() = runTest {
        repository().load()

        val queryIndex = paths.indexOf("/api/databases/$OVERVIEW_PROJECTS_ID/query")
        val sent = Json.parseToJsonElement(bodies[queryIndex]).jsonObject
        val filter = sent.getValue("filter").jsonObject
        assertEquals("equals", filter.getValue("type").jsonPrimitive.content)
        assertEquals("pinned", filter.getValue("property").jsonPrimitive.content)
        val relations = sent.getValue("include").jsonObject.getValue("relations").jsonObject
        assertTrue(relations.getValue("area").jsonArray.isEmpty())
    }

    @Test
    fun aProjectWithoutAnAreaHasNoAreaName() = runTest {
        val noArea = PROJECTS.replace(""","relations":{"area":[{"id":"area-work","title":"Work"}]}""", "")
        val engine = MockEngine { request ->
            when (request.url.encodedPath) {
                "/api/overview" -> json(OVERVIEW)
                "/api/databases" -> json(DATABASES)
                "/api/databases/$OVERVIEW_AREAS_ID/query" -> json(AREAS)
                else -> json(noArea)
            }
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val repo = HttpOverviewRepository(AuthenticatedApi(ApiClient(engine), storage, onSessionRejected = {}))

        val overview = assertIs<RepositoryResult.Content<Overview>>(repo.load()).value

        assertNull(overview.projects.single().areaName)
    }

    @Test
    fun aFailureOfTheOverviewIsThatFailure() = runTest {
        val repo = repository { request -> "{}".takeIf { request.url.encodedPath == "/api/overview" } }

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(repo.load()).kind)
    }

    @Test
    fun aFailureOfTheAreasIsThatFailure() = runTest {
        val repo =
            repository { request -> "{}".takeIf { request.url.encodedPath.endsWith("$OVERVIEW_AREAS_ID/query") } }

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(repo.load()).kind)
    }

    @Test
    fun anUnreadableOverviewIsInvalidData() = runTest {
        val repo = repository(overview = """{"inboxPending":"many"}""")

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(repo.load()).kind)
    }

    @Test
    fun aFailureOfTheProjectsIsThatFailure() = runTest {
        val repo =
            repository { request -> "{}".takeIf { request.url.encodedPath.endsWith("$OVERVIEW_PROJECTS_ID/query") } }

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(repo.load()).kind)
    }

    @Test
    fun aFailureOfTheDatabasesIsThatFailure() = runTest {
        val repo = repository { request -> "{}".takeIf { request.url.encodedPath == "/api/databases" } }

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(repo.load()).kind)
    }
}
