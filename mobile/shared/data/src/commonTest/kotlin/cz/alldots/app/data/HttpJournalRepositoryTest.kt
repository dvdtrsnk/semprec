package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.ClockTime
import cz.alldots.app.domain.JournalPeriod
import cz.alldots.app.domain.JournalPeriodType
import cz.alldots.app.domain.PageDocument
import cz.alldots.app.domain.PageWrite
import cz.alldots.app.domain.RepositoryResult
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
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val DAY = JournalPeriod(JournalPeriodType.DAY, "2026-10-16")
private val MONTH = JournalPeriod(JournalPeriodType.MONTH, "2026-10")
private val YEAR = JournalPeriod(JournalPeriodType.YEAR, "2026")

private const val DAY_BODY = """{
  "type":"day","period":"2026-10-16","range":{"from":"2026-10-16","to":"2026-10-16"},
  "path":{"year":{"period":"2026","range":{"from":"2026-01-01","to":"2026-12-31"}}},
  "today":"2026-10-17","item":{"id":"item-day","properties":{}},"docId":"doc-day","markdown":"Hello",
  "week":{"period":"2026-W42","range":{"from":"2026-10-12","to":"2026-10-18"},"itemId":null,"docId":null,"markdown":null},
  "inbox":[
    {"id":"i1","date":"2026-10-16","time":"08:15","text":"Idea","type":{"id":"t","name":"Idea","emoji":"x"},
     "status":"proposed","processing":"proposed","proposalSummary":null,
     "attachments":[{"attachmentId":"a","blobId":"b","name":"scan.pdf","mimeType":"application/pdf","byteSize":1}]},
    {"id":"i2","date":null,"time":null,"text":"  ","type":null,"status":null,"processing":null,"attachments":[]}
  ],
  "events":[
    {"id":"e1","title":"Standup","type":null,"date":"2026-10-16","endDate":null,"timeFrom":"09:00","timeTo":"09:30",
     "allDay":false,"place":"","project":{"id":"p","name":"Alldots iOS","color":"#007AFF"},"calendarId":null,
     "transcript":{"id":"t","status":"done"}},
    {"id":"e2","title":"Trip","timeFrom":null,"timeTo":null,"allDay":true,"place":"Hotel"}
  ],
  "birthdays":[{"id":"birthday:1:2026","personId":"1","personName":"Jana Kovarova","title":"Jana","date":"2026-10-16"}]
}"""

private const val MONTH_BODY = """{
  "type":"month","period":"2026-10","range":{"from":"2026-10-01","to":"2026-10-31"},"today":"2026-10-16",
  "item":null,"markdown":null,
  "weeks":[
    {"period":"2026-W40","range":{"from":"2026-09-28","to":"2026-10-04"},"itemId":"w40","docId":"d","markdown":"Dovolena"},
    {"period":"2026-W41","range":{"from":"2026-10-05","to":"2026-10-11"},"itemId":null,"docId":null,"markdown":null}
  ]
}"""

private const val YEAR_BODY = """{
  "type":"year","period":"2026","range":{"from":"2026-01-01","to":"2026-12-31"},"today":"2026-10-16",
  "item":{"id":"item-year"},"markdown":"Year goals",
  "quarters":[
    {"period":"2026-Q1","range":{"from":"2026-01-01","to":"2026-03-31"},"itemId":null,"docId":null,"markdown":null},
    {"period":"2026-Q2","range":{"from":"2026-04-01","to":"2026-06-30"},"itemId":null,"docId":null,"markdown":null},
    {"period":"2026-Q3","range":{"from":"2026-07-01","to":"2026-09-30"},"itemId":null,"docId":null,"markdown":null},
    {"period":"2026-Q4","range":{"from":"2026-10-01","to":"2026-12-31"},"itemId":"q4","docId":"d","markdown":"Ship"}
  ]
}"""

class HttpJournalRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()
    private var rejected = 0

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpJournalRepository {
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        return HttpJournalRepository(AuthenticatedApi(ApiClient(engine), storage) { rejected += 1 })
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test fun `a day is read with its week events birthdays and inbox`() = runTest {
        val repo = repository { json(DAY_BODY) }

        val page = assertIs<RepositoryResult.Content<cz.alldots.app.domain.JournalPeriodPage>>(repo.period(DAY)).value

        assertEquals("https://s.example/api/journal/periods/day/2026-10-16", requests.single().url.toString())
        assertEquals("Bearer tok", requests.single().headers[HttpHeaders.Authorization])
        assertEquals(CalendarDay(2026, 10, 17), page.today)
        assertEquals("item-day", page.itemId)
        assertEquals("Hello", page.markdown)
        assertEquals(1, page.weeks.size)
        assertEquals(42, page.weeks.single().week)
        assertNull(page.weeks.single().itemId)
        assertEquals(listOf("Standup", "Trip"), page.events.map { it.title })
        assertEquals(ClockTime(540), page.events.first().timeFrom)
        assertEquals(ClockTime(570), page.events.first().timeTo)
        assertNull(page.events.first().place)
        assertEquals("#007AFF", page.events.first().projectColor)
        assertTrue(page.events.first().hasTranscript)
        assertTrue(page.events.last().allDay)
        assertEquals("Hotel", page.events.last().place)
        assertEquals("Jana Kovarova", page.birthdays.single().personName)
        assertEquals("scan.pdf", page.inbox.first().attachmentName)
        assertEquals(1, page.inbox.first().attachmentCount)
        assertEquals("x", page.inbox.first().typeEmoji)
        assertNull(page.inbox.last().text)
    }

    @Test fun `a month is read with its weeks and no page yet`() = runTest {
        val repo = repository { json(MONTH_BODY) }

        val page = assertIs<RepositoryResult.Content<cz.alldots.app.domain.JournalPeriodPage>>(repo.period(MONTH)).value

        assertNull(page.itemId)
        assertNull(page.markdown)
        assertEquals(listOf(40, 41), page.weeks.map { it.week })
        assertEquals("Dovolena", page.weeks.first().markdown)
        assertEquals("w40", page.weeks.first().itemId)
        assertEquals(CalendarDay(2026, 9, 28), page.weeks.first().from)
    }

    @Test fun `a year is read with its page and its four quarters`() = runTest {
        val repo = repository { json(YEAR_BODY) }

        val page = assertIs<RepositoryResult.Content<cz.alldots.app.domain.JournalPeriodPage>>(repo.period(YEAR)).value

        assertEquals("https://s.example/api/journal/periods/year/2026", requests.single().url.toString())
        assertEquals("Year goals", page.markdown)
        assertEquals(listOf(1, 2, 3, 4), page.quarters.map { it.quarter })
        assertNull(page.quarters.first().itemId)
        assertEquals("q4", page.quarters.last().itemId)
        assertEquals("Ship", page.quarters.last().markdown)
        assertEquals(CalendarDay(2026, 10, 1), page.quarters.last().from)
        assertEquals(CalendarDay(2026, 12, 31), page.quarters.last().to)
        assertTrue(page.weeks.isEmpty())
    }

    @Test fun `a quarter that is not named by its number is invalid data`() = runTest {
        val repo = repository { json(YEAR_BODY.replace("\"2026-Q4\"", "\"2026-Q5\"")) }

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(repo.period(YEAR)).kind)
    }

    @Test fun `a quarter with an unreadable date is invalid data`() = runTest {
        val repo = repository { json(YEAR_BODY.replace("\"to\":\"2026-03-31\"", "\"to\":\"later\"")) }

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(repo.period(YEAR)).kind)
    }

    @Test fun `an answer with an unreadable date is invalid data`() = runTest {
        val repo = repository { json(DAY_BODY.replace("\"today\":\"2026-10-17\"", "\"today\":\"soon\"")) }

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(repo.period(DAY)).kind)
    }

    @Test fun `an answer that is not a period is invalid data`() = runTest {
        val repo = repository { json("""{"unexpected":true}""") }

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(repo.period(DAY)).kind)
    }

    @Test fun `failures of the period read keep their kind`() = runTest {
        assertEquals(
            FailureKind.NOT_FOUND,
            assertIs<RepositoryResult.Failure>(
                repository {
                    json("{}", HttpStatusCode.NotFound)
                }.period(DAY)
            ).kind
        )
        assertEquals(
            FailureKind.REJECTED,
            assertIs<RepositoryResult.Failure>(
                repository {
                    json("{}", HttpStatusCode.BadRequest)
                }.period(DAY)
            ).kind
        )
        assertEquals(
            FailureKind.UNAVAILABLE,
            assertIs<RepositoryResult.Failure>(
                repository {
                    error("offline")
                }.period(DAY)
            ).kind
        )
        assertEquals(0, rejected)
    }

    @Test fun `a rejected session is reported once`() = runTest {
        val repo = repository { json("{}", HttpStatusCode.Unauthorized) }

        assertEquals(FailureKind.UNAUTHORIZED, assertIs<RepositoryResult.Failure>(repo.period(DAY)).kind)
        assertEquals(1, rejected)
    }

    @Test fun `ensuring a page puts the doc of the period and returns its item`() = runTest {
        val repo = repository {
            json("""{"itemId":"item-1","docId":"doc-1","period":"2026-10-16","range":{"from":"a","to":"b"}}""")
        }

        assertEquals("item-1", assertIs<RepositoryResult.Content<String>>(repo.ensurePage(DAY)).value)
        assertEquals(HttpMethod.Put, requests.single().method)
        assertEquals("https://s.example/api/journal/periods/day/2026-10-16/doc", requests.single().url.toString())
    }

    @Test fun `a page is read with its markdown and version`() = runTest {
        val repo = repository {
            respond("# Title\n\nText", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"v1\""))
        }

        val document = assertIs<RepositoryResult.Content<PageDocument>>(repo.page("item-1")).value

        assertEquals(PageDocument("# Title\n\nText", "\"v1\""), document)
        assertEquals("https://s.example/api/items/item-1/page.md", requests.single().url.toString())
    }

    @Test fun `a page answer without a version is invalid data`() = runTest {
        val repo = repository { respond("text", HttpStatusCode.OK) }

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(repo.page("item-1")).kind)
    }

    @Test fun `replacing a page quotes the version and sends markdown`() = runTest {
        val repo =
            repository { respond("""{"trashedPages":[]}""", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"v2\"")) }

        val replaced = repo.replacePage("item-1", "New", "\"v1\"", "Old")
        val written = assertIs<RepositoryResult.Content<PageWrite>>(replaced).value

        assertEquals(PageWrite.Saved("\"v2\""), written)
        val request = requests.single()
        assertEquals(HttpMethod.Put, request.method)
        assertEquals("\"v1\"", request.headers[HttpHeaders.IfMatch])
        assertTrue(request.body.contentType.toString().startsWith("text/markdown"))
        assertEquals("New", bodies.single())
    }

    @Test fun `a changed page is a conflict and not a failure`() = runTest {
        assertEquals(
            PageWrite.Conflict,
            assertIs<RepositoryResult.Content<PageWrite>>(
                repository { json("{}", HttpStatusCode.Conflict) }.replacePage("i", "x", "\"v1\"", ""),
            ).value,
        )
        assertEquals(
            PageWrite.Conflict,
            assertIs<RepositoryResult.Content<PageWrite>>(
                repository { json("{}", HttpStatusCode.PreconditionFailed) }.replacePage("i", "x", "\"v1\"", ""),
            ).value,
        )
    }

    @Test fun `other write failures keep their kind`() = runTest {
        assertEquals(
            FailureKind.UNAVAILABLE,
            assertIs<RepositoryResult.Failure>(
                repository { json("{}", HttpStatusCode.InternalServerError) }.replacePage("i", "x", "\"v1\"", ""),
            ).kind,
        )
        assertEquals(
            FailureKind.REJECTED,
            assertIs<RepositoryResult.Failure>(
                repository { json("{}", HttpStatusCode.BadRequest) }.replacePage("i", "x", "\"v1\"", ""),
            ).kind,
        )
    }
}
