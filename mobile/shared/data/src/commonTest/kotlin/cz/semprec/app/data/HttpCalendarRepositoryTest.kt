package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.CalendarWindow
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.EventTaskState
import cz.semprec.app.domain.NewCalendarItem
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TraceOutcome
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SERVER = "https://s.example"
private val DAY = CalendarDay(2026, 10, 16)
private const val SCHEMA =
    """{"databases":[{"databaseId":"db-cal","key":"calendars"},{"databaseId":"db-ev","key":"events"},""" +
        """{"databaseId":"db-task","key":"tasks"},{"databaseId":"db-inv","key":"invitations"}]}"""
private const val TIMELINE =
    """{"timezone":"Europe/Prague","today":"2026-10-16","now":{"date":"2026-10-16","time":"13:24"},""" +
        """"from":"2026-10-12","to":"2026-10-18","items":[""" +
        """{"kind":"holiday","id":"holiday:cz:2026-10-16","title":"Holiday","date":"2026-10-16","allDay":true,""" +
        """"calendarId":"cal-h"},""" +
        """{"kind":"event","id":"ev1","title":"Meeting","date":"2026-10-16","endDate":null,"timeFrom":"10:00",""" +
        """"timeTo":"11:30","effectiveTo":"11:30","hasEnd":true,"allDay":false,"calendarId":"cal-w","status":null,""" +
        """"place":"Office","readOnly":false,"updatedAt":"v-ev1","attendance":"tentative",""" +
        """"tasks":[{"taskId":"t9","title":"Agenda","state":{"kind":"doneElsewhere","eventName":"Review"}},""" +
        """{"taskId":"t8","title":"Slides","state":{"kind":"open"}}],"counts":{"open":1,"total":2}},""" +
        """{"kind":"event","id":"series1@2026-10-16","title":"Standup","date":"2026-10-16","endDate":null,""" +
        """"timeFrom":"09:00","timeTo":"09:30","effectiveTo":"09:30","allDay":false,"calendarId":"cal-w",""" +
        """"readOnly":true,"updatedAt":"v-s","seriesId":"series1","occurrenceDate":"2026-10-16",""" +
        """"overridden":false},""" +
        """{"kind":"task","id":"t1","title":"Invoice","date":"2026-10-16","timeFrom":"14:00","timeTo":null,""" +
        """"effectiveTo":"14:00","allDay":false,"calendarId":"cal-t","status":"notDone","readOnly":false,""" +
        """"updatedAt":"v-t1","carriedFrom":"2026-10-14","hostEvent":{"id":"ev1","title":"Meeting"}},""" +
        """{"kind":"trace","id":"trace:t1:2026-10-14","taskId":"t1","day":"2026-10-14","firstDay":"2026-10-14",""" +
        """"sinceTime":{"from":"15:00","to":null},"outcome":{"kind":"movedToEvent","id":"ev1",""" +
        """"title":"Meeting"},"readOnly":true},""" +
        """{"kind":"sleep","id":"sleep:2026-10-15","night":"2026-10-15","planId":"p1","bedTime":"23:00",""" +
        """"wakeTime":"06:45",""" +
        """"alarm":true,"changed":true,"bedAt":"x","wakeAt":"y","prepReminderAt":"2026-10-15T22:30:00+02:00"},""" +
        """{"kind":"birthday","id":"birthday:p1:2026","title":"Jana","date":"2026-10-16","allDay":true,""" +
        """"calendarId":null},""" +
        """{"kind":"mystery","id":"m1"},{"kind":"event","id":"bad","title":"Bad","date":"nonsense"}]}"""
private const val CALENDARS =
    """{"items":[{"id":"cal-w","updatedAt":"v1","properties":{"name":"Work","color":"#007AFF","notify":true,""" +
        """"hidden":false,"isDefault":false,"kind":"own"}},{"id":"cal-h","updatedAt":"v2",""" +
        """"properties":{"name":"Holidays",""" +
        """"color":"#34C759","hidden":true,"kind":"subscription"}},{"id":"cal-x","updatedAt":"v3",""" +
        """"properties":{"color":"#000000"}}]}"""

class HttpCalendarRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()
    private val changes = CalendarChanges()

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpCalendarRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession(SERVER, "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpCalendarRepository(AuthenticatedApi(ApiClient(engine), storage) {}, changes)
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun HttpRequestData.path() = url.encodedPath

    private fun MockRequestHandleScope.reads(request: HttpRequestData): HttpResponseData = when (request.path()) {
        "/api/schema" -> json(SCHEMA)
        "/api/calendar/timeline" -> json(TIMELINE)
        "/api/databases/db-cal/query" -> json(CALENDARS)
        "/api/badge-counts" -> json("""{"pendingApprovals":0,"pendingInvites":3,"openInboxItems":0}""")
        else -> json("""{"id":"new1","updatedAt":"v-new","properties":{}}""")
    }

    private fun sent(index: Int): JsonObject = Json.parseToJsonElement(bodies[index]).jsonObject

    private suspend fun HttpCalendarRepository.loaded(): CalendarWindow =
        assertIs<RepositoryResult.Content<CalendarWindow>>(window(DAY.plusDays(-4), DAY.plusDays(2))).value

    private fun entryOf(
        id: String = "ev1",
        kind: CalendarEntryKind = CalendarEntryKind.EVENT,
        seriesId: String? = null,
        readOnly: Boolean = false,
    ) = CalendarEntry(
        id, kind, "T", null, DAY, null, ClockTime(600), ClockTime(660), ClockTime(660), false, null, null, readOnly,
        "v-old", seriesId = seriesId, occurrenceDate = DAY,
    )

    @Test fun `the window asks for the range and carries the calendars and the badge`() = runTest {
        val window = repository { reads(it) }.loaded()
        val ask = requests.single { it.path() == "/api/calendar/timeline" }
        assertEquals("2026-10-12", ask.url.parameters["from"])
        assertEquals("2026-10-18", ask.url.parameters["to"])
        assertEquals("Bearer tok", ask.headers[HttpHeaders.Authorization])
        assertEquals(3, window.pendingInvitations)
        assertEquals(listOf("cal-w", "cal-h"), window.calendars.map { it.id })
        assertEquals(true, window.calendars[1].hidden)
        assertEquals(cz.semprec.app.domain.CalendarKind.SUBSCRIPTION, window.calendars[1].kind)
        assertEquals(DAY, window.timeline.today)
        assertEquals(13 * 60 + 24, window.timeline.nowMinutes)
    }

    @Test fun `every kind of entry is mapped and unknown or unreadable ones are skipped`() = runTest {
        val entries = repository { reads(it) }.loaded().timeline.entries
        assertEquals(
            listOf("holiday", "event", "event", "task", "trace", "sleep", "birthday"),
            entries.map { it.kind.name.lowercase() },
        )
        val event = entries[1]
        assertEquals("Meeting", event.title)
        assertEquals(ClockTime(630 + 60), event.effectiveTo)
        assertEquals("Office", event.place)
        assertEquals(true, event.tentative)
        assertEquals(listOf(EventTaskState.DONE_ELSEWHERE, EventTaskState.OPEN), event.tasks.map { it.state })
        assertEquals("Review", event.tasks[0].note)
        assertEquals(true, entries[2].isVirtualOccurrence)
        val task = entries[3]
        assertEquals(DAY.plusDays(-2), task.carriedFrom)
        assertEquals("Meeting", task.hostEventTitle)
        assertNull(task.timeTo)
    }

    @Test fun `a trace takes the title of its task and a sleep night carries its times`() = runTest {
        val entries = repository { reads(it) }.loaded().timeline.entries
        val trace = entries.single { it.kind == CalendarEntryKind.TRACE }
        assertEquals("Invoice", trace.title)
        assertEquals(TraceOutcome.MOVED_TO_EVENT, trace.trace)
        assertEquals("Meeting", trace.traceNote)
        assertEquals(ClockTime(15 * 60), trace.timeFrom)
        assertEquals("t1", trace.sourceTaskId)
        val sleep = entries.single { it.kind == CalendarEntryKind.SLEEP }.sleep
        assertEquals(ClockTime(23 * 60), sleep?.bedTime)
        assertEquals(true, sleep?.alarm)
        assertEquals(true, sleep?.changed)
        assertEquals("2026-10-15T22:30:00+02:00", sleep?.prepReminderAt)
    }

    @Test fun `a failing timeline calendars or badge fails the window`() = runTest {
        val onTimeline = repository { request ->
            if (request.path() == "/api/calendar/timeline") json("{}", HttpStatusCode.BadGateway) else reads(request)
        }
        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(onTimeline.window(DAY, DAY)).kind)
        val onCalendars = repository { request ->
            if (request.path() == "/api/databases/db-cal/query") json("{}", HttpStatusCode.NotFound) else reads(request)
        }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(onCalendars.window(DAY, DAY)).kind)
        val onBadge =
            repository { if (it.path() == "/api/badge-counts") json("{}", HttpStatusCode.Forbidden) else reads(it) }
        assertEquals(FailureKind.UNAUTHORIZED, assertIs<RepositoryResult.Failure>(onBadge.window(DAY, DAY)).kind)
    }

    @Test fun `an unreadable timeline is invalid data and a tenant without calendars is not found`() = runTest {
        val garbled = repository { request ->
            if (request.path() == "/api/calendar/timeline") json("""{"nope":1}""") else reads(request)
        }
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(garbled.window(DAY, DAY)).kind)
        val badTimeline = TIMELINE.replace("\"today\":\"2026-10-16\"", "\"today\":\"x\"")
        val badToday = repository { request ->
            if (request.path() == "/api/calendar/timeline") json(badTimeline) else reads(request)
        }
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(badToday.window(DAY, DAY)).kind)
        val noCalendars = repository { request ->
            if (request.path() == "/api/schema") json("""{"databases":[]}""") else reads(request)
        }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(noCalendars.window(DAY, DAY)).kind)
    }

    @Test fun `a move patches the schedule against the version of the timeline`() = runTest {
        val schedule = CalendarSchedule(DAY.plusDays(1), null, ClockTime(14 * 60), ClockTime(15 * 60))
        val result = repository { reads(it) }.reschedule(entryOf(), schedule)
        assertEquals(RepositoryResult.Content(Unit), result)
        val patch = requests.single()
        assertEquals(HttpMethod.Patch, patch.method)
        assertEquals("/api/items/ev1", patch.path())
        val body = sent(0)
        assertEquals("v-old", body["ifVersion"]?.jsonPrimitive?.content)
        val properties = body["properties"]!!.jsonObject
        assertEquals("2026-10-17", properties["date"]?.jsonPrimitive?.content)
        assertEquals("14:00", properties["timeFrom"]?.jsonPrimitive?.content)
        assertEquals("15:00", properties["timeTo"]?.jsonPrimitive?.content)
        assertEquals(JsonNull, properties["endDate"])
        assertEquals(1, changes.revision.value)
    }

    @Test fun `a task patch never carries an end date and an all day move clears the times`() = runTest {
        val allDay = CalendarSchedule(DAY, null, null, null)
        repository { reads(it) }.reschedule(entryOf(id = "t1", kind = CalendarEntryKind.TASK), allDay)
        val properties = sent(0)["properties"]!!.jsonObject
        assertEquals(JsonNull, properties["timeFrom"])
        assertEquals(JsonNull, properties["timeTo"])
        assertTrue("endDate" !in properties)
    }

    @Test fun `an entry without a version is patched without the check`() = runTest {
        val listed = entryOf(id = "t1", kind = CalendarEntryKind.TASK).copy(updatedAt = null)
        repository { reads(it) }.setTaskDone(listed, true)
        assertTrue("ifVersion" !in sent(0))
        assertEquals("done", sent(0)["properties"]!!.jsonObject["status"]?.jsonPrimitive?.content)
    }

    @Test fun `a series occurrence is stored first and the patch goes to the stored item`() = runTest {
        val repo = repository { reads(it) }
        val occurrence = entryOf(id = "series1@2026-10-16", seriesId = "series1", readOnly = true)
        repo.reschedule(occurrence, CalendarSchedule(DAY, null, ClockTime(0), ClockTime(60)))
        assertEquals("/api/events/series/series1/occurrences/2026-10-16", requests[0].path())
        assertEquals(HttpMethod.Post, requests[0].method)
        assertEquals("/api/items/new1", requests[1].path())
        assertEquals("v-new", sent(1)["ifVersion"]?.jsonPrimitive?.content)
    }

    @Test fun `a task occurrence is stored through the tasks family`() = runTest {
        val occurrence = entryOf(id = "s@2026-10-16", kind = CalendarEntryKind.TASK, seriesId = "s", readOnly = true)
        repository { reads(it) }.setTaskDone(occurrence, true)
        assertEquals("/api/tasks/series/s/occurrences/2026-10-16", requests[0].path())
        assertEquals("done", sent(1)["properties"]!!.jsonObject["status"]?.jsonPrimitive?.content)
    }

    @Test fun `a task is done and open again by its status`() = runTest {
        val repo = repository { reads(it) }
        repo.setTaskDone(entryOf(id = "t1", kind = CalendarEntryKind.TASK), true)
        repo.setTaskDone(entryOf(id = "t1", kind = CalendarEntryKind.TASK), false)
        assertEquals("done", sent(0)["properties"]!!.jsonObject["status"]?.jsonPrimitive?.content)
        assertEquals("notDone", sent(1)["properties"]!!.jsonObject["status"]?.jsonPrimitive?.content)
    }

    @Test fun `a conflict or a missing item comes back as a failure and nothing changes`() = runTest {
        val conflict = repository { json("{}", HttpStatusCode.Conflict) }
        val moved = entryOf().schedule.copy(date = DAY.plusDays(1))
        val failure = assertIs<RepositoryResult.Failure>(conflict.reschedule(entryOf(), moved))
        assertEquals(FailureKind.REJECTED, failure.kind)
        val gone = repository { json("{}", HttpStatusCode.NotFound) }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(gone.delete(entryOf())).kind)
        assertEquals(0, changes.revision.value)
    }

    @Test fun `a task is put into an event through its host events`() = runTest {
        val repo = repository { reads(it) }
        val result = repo.putTaskInEvent(entryOf(id = "t1", kind = CalendarEntryKind.TASK), entryOf(id = "ev1"))
        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(HttpMethod.Put, requests.single().method)
        assertEquals("/api/tasks/t1/host-events/ev1", requests.single().path())
        assertEquals(1, changes.revision.value)
    }

    @Test fun `a task goes into an occurrence of a series after it is stored`() = runTest {
        val event = entryOf(id = "series1@2026-10-16", seriesId = "series1", readOnly = true)
        repository { reads(it) }.putTaskInEvent(entryOf(id = "t1", kind = CalendarEntryKind.TASK), event)
        assertEquals("/api/events/series/series1/occurrences/2026-10-16", requests[0].path())
        assertEquals("/api/tasks/t1/host-events/new1", requests[1].path())
    }

    @Test fun `a failing host event write fails the move into the event`() = runTest {
        val repo = repository { request ->
            if (request.method == HttpMethod.Put) json("{}", HttpStatusCode.Conflict) else reads(request)
        }
        val result = repo.putTaskInEvent(entryOf(id = "t1", kind = CalendarEntryKind.TASK), entryOf())
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test fun `a duplicate posts the new schedule and answers the copy`() = runTest {
        val schedule = CalendarSchedule(DAY.plusDays(3), DAY.plusDays(4), ClockTime(600), ClockTime(660))
        val result = repository { reads(it) }.duplicate(entryOf(), schedule)
        assertEquals(RepositoryResult.Content("new1"), result)
        assertEquals("/api/calendar/items/ev1/duplicate", requests.single().path())
        val body = sent(0)
        assertEquals("2026-10-19", body["date"]?.jsonPrimitive?.content)
        assertEquals("2026-10-20", body["endDate"]?.jsonPrimitive?.content)
        assertEquals("10:00", body["timeFrom"]?.jsonPrimitive?.content)
    }

    @Test fun `a duplicate of a task sends no end date`() = runTest {
        repository {
            reads(it)
        }.duplicate(
            entryOf(id = "t1", kind = CalendarEntryKind.TASK),
            CalendarSchedule(DAY, DAY.plusDays(1), null, null),
        )
        assertTrue("endDate" !in sent(0))
    }

    @Test fun `a delete sends the delete of the item`() = runTest {
        val result = repository { reads(it) }.delete(entryOf())
        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(HttpMethod.Delete, requests.single().method)
        assertEquals("/api/items/ev1", requests.single().path())
    }

    @Test fun `a new event is created with its calendar linked afterwards`() = runTest {
        val draft = NewCalendarItem(
            CalendarEntryKind.EVENT,
            "Lunch",
            CalendarSchedule(DAY, null, ClockTime(720), ClockTime(780)),
            "Cafe",
            "cal-w",
        )
        val result = repository { reads(it) }.create(draft)
        assertEquals(RepositoryResult.Content("new1"), result)
        val create = requests.first { it.path() == "/api/databases/db-ev/items" }
        assertEquals(HttpMethod.Post, create.method)
        val properties = sent(requests.indexOf(create))["properties"]!!.jsonObject
        assertEquals("Lunch", properties["name"]?.jsonPrimitive?.content)
        assertEquals("Cafe", properties["place"]?.jsonPrimitive?.content)
        assertEquals("12:00", properties["timeFrom"]?.jsonPrimitive?.content)
        val link = requests.last()
        assertEquals(HttpMethod.Put, link.method)
        assertEquals("/api/items/new1/relations/calendar/cal-w", link.path())
    }

    @Test fun `a new task goes to the tasks database without a place or a calendar link`() = runTest {
        val draft =
            NewCalendarItem(
                CalendarEntryKind.TASK,
                "Pay",
                CalendarSchedule(DAY, DAY.plusDays(1), null, null),
                "x",
                "cal-w",
            )
        repository { reads(it) }.create(draft)
        val create = requests.indexOfFirst { it.path() == "/api/databases/db-task/items" }
        val properties = sent(create)["properties"]!!.jsonObject
        assertEquals("Pay", properties["name"]?.jsonPrimitive?.content)
        assertTrue("place" !in properties)
        assertTrue("endDate" !in properties)
        assertTrue(requests.none { it.method == HttpMethod.Put })
    }

    @Test fun `a refused creation or link fails and a missing database is not found`() = runTest {
        val draft =
            NewCalendarItem(CalendarEntryKind.EVENT, "Lunch", CalendarSchedule(DAY, null, null, null), null, "cal-w")
        val refused = repository { request ->
            val creates = request.method == HttpMethod.Post && request.path().endsWith("/items")
            if (creates) json("{}", HttpStatusCode.BadRequest) else reads(request)
        }
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(refused.create(draft)).kind)
        val unlinked =
            repository { if (it.method == HttpMethod.Put) json("{}", HttpStatusCode.NotFound) else reads(it) }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(unlinked.create(draft)).kind)
        val noDatabase = repository { json("""{"databases":[]}""") }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(noDatabase.create(draft)).kind)
        assertEquals(0, changes.revision.value)
    }
}
