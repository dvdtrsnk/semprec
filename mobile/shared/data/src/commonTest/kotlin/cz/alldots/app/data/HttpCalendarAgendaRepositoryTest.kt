package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.CalendarAgendaPage
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.RepositoryResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

private const val AGENDA_PAGE =
    """{"items":[""" +
        """{"kind":"task","id":"t1","title":"Invoice","date":"2026-11-16","timeFrom":null,"timeTo":null,""" +
        """"effectiveTo":null,"allDay":true,"calendarId":"c","status":"done","readOnly":false,"version":"1"},""" +
        """{"kind":"event","id":"e1","title":"Meeting","date":"2026-11-17","endDate":null,"timeFrom":"14:00",""" +
        """"timeTo":"15:00","effectiveTo":"15:00","allDay":false,"calendarId":"c","status":null,"place":"Praha",""" +
        """"readOnly":false,"version":"1"},""" +
        """{"kind":"event","id":"bad","title":"Bad","date":"nonsense"}],"nextCursor":"MjAyNi0xMS0xOHw"}"""

class HttpCalendarAgendaRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private var handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData =
        { json(AGENDA_PAGE) }

    private fun repository(): HttpCalendarAgendaRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val engine = MockEngine { request ->
            requests += request
            handler(request)
        }
        return HttpCalendarAgendaRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun theFirstPageIsReadForwardFromTheDayAndUnreadableItemsAreLeftOut() = runTest {
        val page = assertIs<RepositoryResult.Content<CalendarAgendaPage>>(
            repository().page(CalendarDay(2026, 11, 16), null),
        ).value

        val url = requests.single().url
        assertEquals("/api/calendar/agenda", url.encodedPath)
        assertEquals("2026-11-16", url.parameters["from"])
        assertEquals("forward", url.parameters["direction"])
        assertEquals("50", url.parameters["limit"])
        assertNull(url.parameters["cursor"])
        assertEquals(listOf("t1", "e1"), page.entries.map { it.id })
        assertEquals(listOf(CalendarEntryKind.TASK, CalendarEntryKind.EVENT), page.entries.map { it.kind })
        assertEquals(true, page.entries[0].isDone)
        assertEquals("Praha", page.entries[1].place)
        assertEquals("MjAyNi0xMS0xOHw", page.nextCursor)
    }

    @Test
    fun aFurtherPageCarriesTheCursorAndTheLastPageHasNone() = runTest {
        handler = { json("""{"items":[]}""") }

        val page = assertIs<RepositoryResult.Content<CalendarAgendaPage>>(
            repository().page(CalendarDay(2026, 11, 16), "MjAyNi0xMS0xOHw"),
        ).value

        assertEquals("MjAyNi0xMS0xOHw", requests.single().url.parameters["cursor"])
        assertEquals(emptyList(), page.entries)
        assertNull(page.nextCursor)
    }

    @Test
    fun aRefusedReadIsItsFailure() = runTest {
        handler = { json("""{"error":{"code":"validation_failed"}}""", HttpStatusCode.BadRequest) }

        val result = repository().page(CalendarDay(2026, 11, 16), "broken")

        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
    }
}
