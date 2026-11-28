package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.SearchGroupType
import cz.alldots.app.core.SearchSubtitleKind
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SearchGroup
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

private const val ANSWER = """{"groups":[
    {"type":"task","total":6,"nextCursor":null,"items":[
    {"itemId":"t1","databaseId":"d","databaseKey":"tasks","title":"Odeslat fakturu","snippet":null,
    "subtitleParts":[{"kind":"date","value":"2026-10-16"},{"kind":"timeRange","value":"14:00-15:30"},
    {"kind":"project","value":"Účetnictví","itemId":"p1"},{"kind":"futureKind","value":"x"}]}]},
    {"type":"journal","total":1,"items":[
    {"itemId":"j1","databaseId":"d","databaseKey":"journal","title":"Pátek","snippet":"Standup v pohodě",
    "subtitleParts":[],"journal":{"type":"day","period":"2026-10-16"}}]},
    {"type":"mail","total":1,"items":[
    {"threadId":"th1","itemId":"m1","databaseId":"d","databaseKey":"emails","title":"Re: Nabídka","snippet":null,
    "subtitleParts":[{"kind":"sender","value":"Petr"}]}]},
    {"type":"somethingNew","total":1,"items":[]}]}"""

class HttpSearchRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun repository(status: HttpStatusCode = HttpStatusCode.OK, body: String = ANSWER): HttpSearchRepository {
        val engine = MockEngine { request ->
            requests += request
            respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        return HttpSearchRepository(AuthenticatedApi(ApiClient(engine), storage, onSessionRejected = {}))
    }

    @Test
    fun theGroupsAndTheirResultsAreMappedAndUnknownGroupsAndPartsAreDropped() = runTest {
        val result = repository().search("faktura", null, 4)

        val groups = assertIs<RepositoryResult.Content<List<SearchGroup>>>(result).value
        val types = listOf(SearchGroupType.TASK, SearchGroupType.JOURNAL, SearchGroupType.MAIL)
        assertEquals(types, groups.map { it.type })
        val task = groups[0]
        assertEquals(6, task.total)
        val first = task.results.single()
        assertEquals("t1", first.itemId)
        assertEquals("tasks", first.databaseKey)
        assertEquals(
            listOf(SearchSubtitleKind.DATE, SearchSubtitleKind.TIME_RANGE, SearchSubtitleKind.PROJECT),
            first.subtitle.map { it.kind },
        )
        assertEquals("p1", first.subtitle[2].itemId)
        assertNull(first.snippet)
        val journal = groups[1].results.single()
        assertEquals("day", journal.journalType)
        assertEquals("2026-10-16", journal.journalPeriod)
        assertEquals("Standup v pohodě", journal.snippet)
        val mail = groups[2].results.single()
        assertEquals("th1", mail.threadId)
        assertEquals("m1", mail.itemId)
    }

    @Test
    fun theRequestCarriesTheTextTheScopeAndTheLimit() = runTest {
        repository().search("půlmaraton", SearchGroupType.CONTACT, 50)

        val request = requests.single()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("/api/search", request.url.encodedPath)
        assertEquals("půlmaraton", request.url.parameters["q"])
        assertEquals("contact", request.url.parameters["scope"])
        assertEquals("50", request.url.parameters["perGroupLimit"])
    }

    @Test
    fun searchingEverythingSendsNoScope() = runTest {
        repository().search("a", null, 4)

        assertNull(requests.single().url.parameters["scope"])
    }

    @Test
    fun aRefusedAnswerIsThatFailureAndAnUnreadableOneIsInvalidData() = runTest {
        val refused = repository(HttpStatusCode.ServiceUnavailable, "{}").search("a", null, 4)
        val unreadable = repository(body = """{"groups":"no"}""").search("a", null, 4)

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(refused).kind)
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(unreadable).kind)
    }
}
