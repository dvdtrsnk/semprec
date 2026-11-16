package cz.semprec.app.data

import cz.semprec.app.core.AccountRestoreStatus
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AccountRestoreResult
import cz.semprec.app.domain.AccountTrashDatabase
import cz.semprec.app.domain.AccountTrashPage
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val TRASH_ITEMS = """{"totalCount":3,"nextCursor":"next","items":[
    {"item":{"id":"i1","databaseId":"$PROJECTS_ID","properties":{"name":"Starý web"}},"databaseId":"$PROJECTS_ID",
    "databaseKey":"projects","databaseName":"Projekty","deletedAt":"2026-10-21T10:00:00.000Z","daysLeft":30},
    {"item":{"id":"i2","databaseId":"$FILES_ID","properties":{}},"databaseId":"$FILES_ID","databaseKey":"files",
    "databaseName":null,"page":{"title":"Poznámky"},"deletedAt":"2026-10-20T10:00:00.000Z","daysLeft":29},
    {"item":{"id":"i3","databaseId":"unknown","properties":{"name":"x"}},"databaseId":"unknown",
    "deletedAt":"2026-10-19T10:00:00.000Z","daysLeft":0}]}"""

private const val TRASH_DATABASES = """{"totalCount":2,"databases":[
    {"id":"d1","key":null,"name":"Recepty","liveItemCount":42,"archivedAt":"2026-10-18T10:00:00.000Z","daysLeft":27},
    {"id":"d2","key":null,"name":null,"liveItemCount":0,"archivedAt":"2026-10-01T10:00:00.000Z","daysLeft":null}]}"""

class HttpAccountTrashRepositoryTest {
    private fun repository(recorder: Recorder): HttpAccountTrashRepository {
        val reads = HttpCollectionReads(recorder.api)
        return HttpAccountTrashRepository(recorder.api, reads)
    }

    private fun recorder(items: String = TRASH_ITEMS, databases: String = TRASH_DATABASES, restore: String = "{}") =
        Recorder { request ->
            when (request.url.encodedPath) {
                "/api/schema" -> json(SCHEMA_JSON)
                "/api/trash/items" -> json(items)
                "/api/trash/databases" -> json(databases)
                "/api/trash/restore" -> json(restore)
                else -> json("{}", HttpStatusCode.NotFound)
            }
        }

    @Test
    fun anItemIsTitledByTheTitlePropertyOfItsDatabaseOrByItsPageAndKeepsTheServersNames() = runTest {
        val recorder = recorder()

        val page = assertIs<RepositoryResult.Content<AccountTrashPage>>(repository(recorder).items(null)).value

        val items = recorder.requests.filter { it.url.encodedPath == "/api/trash/items" }
        assertEquals("50", items.single().url.parameters["limit"])
        assertNull(items.single().url.parameters["cursor"])
        assertEquals(listOf("Starý web", "Poznámky", ""), page.items.map { it.title })
        assertEquals(listOf("Projekty", "Soubory", ""), page.items.map { it.databaseName })
        assertEquals(listOf("projects", "files", null), page.items.map { it.databaseKey })
        assertEquals(listOf(30, 29, 0), page.items.map { it.daysLeft })
        assertEquals(3, page.totalCount)
        assertEquals("next", page.nextCursor)
    }

    @Test
    fun theNextPageSendsTheCursor() = runTest {
        val recorder = recorder()

        repository(recorder).items("abc")

        val items = recorder.requests.first { it.url.encodedPath == "/api/trash/items" }
        assertEquals("abc", items.url.parameters["cursor"])
    }

    @Test
    fun theDatabasesKeepTheirItemCountAndAMissingDeadline() = runTest {
        val databases = assertIs<RepositoryResult.Content<List<AccountTrashDatabase>>>(
            repository(recorder()).databases(),
        ).value

        assertEquals(
            listOf(
                AccountTrashDatabase("d1", "Recepty", 42, "2026-10-18T10:00:00.000Z", 27),
                AccountTrashDatabase("d2", "", 0, "2026-10-01T10:00:00.000Z", null),
            ),
            databases,
        )
    }

    @Test
    fun restoringSendsTheIdsOfBothKindsAndMapsEveryStatus() = runTest {
        val answer = """{"results":[{"id":"a","kind":"item","status":"restored"},
            {"id":"b","kind":"item","status":"not_found"},{"id":"c","kind":"item","status":"database_archived"},
            {"id":"d","kind":"database","status":"conflict"},{"id":"e","kind":"item","status":"future"}]}"""
        val recorder = recorder(restore = answer)

        val results = assertIs<RepositoryResult.Content<List<AccountRestoreResult>>>(
            repository(recorder).restore(listOf("a", "b"), listOf("d")),
        ).value

        val request = recorder.requests.single { it.url.encodedPath == "/api/trash/restore" }
        assertEquals(HttpMethod.Post, request.method)
        val body = recorder.bodyJson(recorder.requests.indexOf(request))
        assertEquals(listOf("a", "b"), body.getValue("itemIds").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("d"), body.getValue("databaseIds").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(
            listOf(
                AccountRestoreStatus.RESTORED,
                AccountRestoreStatus.NOT_FOUND,
                AccountRestoreStatus.DATABASE_ARCHIVED,
                AccountRestoreStatus.CONFLICT,
                AccountRestoreStatus.NOT_FOUND,
            ),
            results.map { it.status },
        )
    }

    @Test
    fun aRestoreOfOneKindSendsOnlyThatList() = runTest {
        val recorder = recorder()

        repository(recorder).restore(listOf("a"), emptyList())

        val body = recorder.bodyJson(recorder.requests.indexOfFirst { it.url.encodedPath == "/api/trash/restore" })
        assertTrue("databaseIds" !in body)
        assertTrue("itemIds" in body)
    }

    @Test
    fun aRestoreOfNothingIsRejectedWithoutARequest() = runTest {
        val recorder = recorder()

        val result = repository(recorder).restore(emptyList(), emptyList())

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), result)
        assertTrue(recorder.requests.isEmpty())
    }

    @Test
    fun aFailingListAndAFailingSchemaAreFailuresOfTheirKind() = runTest {
        val down = Recorder { json("{}", HttpStatusCode.ServiceUnavailable) }
        val noSchema = Recorder { request ->
            if (request.url.encodedPath == "/api/schema") {
                json("{}", HttpStatusCode.ServiceUnavailable)
            } else {
                json(TRASH_ITEMS)
            }
        }

        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), repository(down).items(null))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), repository(noSchema).items(null))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), repository(down).databases())
        val restore = repository(down).restore(listOf("a"), emptyList())
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), restore)
    }
}
