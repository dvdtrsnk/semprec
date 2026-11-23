package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarRepeat
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.InboxCapture
import cz.semprec.app.domain.InvitationAnswer
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.NewCalendarItem
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.TestTimeSource

private val OFFLINE_DAY = CalendarDay(2026, 11, 23)
private const val KEPT_ITEM =
    """{"id":"i1","databaseId":"d1","properties":{"name":"Old","place":"Here"},"version":"v1"}"""
private const val KEPT_TARGET = """{"id":"p1","databaseId":"d2","properties":{"name":"Garden"},"version":"v1"}"""
private const val KEPT_SCHEMA =
    """{"databases":[{"databaseId":"db-events","key":"events"},{"databaseId":"db-tasks","key":"tasks"}]}"""
private const val KEPT_SERIES =
    """{"id":"s1","databaseId":"db-events","properties":{"name":"Standup"},"version":"v1"}"""

/**
 * Every queued route answers what the device makes up, and the repository that sends it decodes that answer while
 * the server cannot be reached.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class QueuedWritesRepositoryTest {
    private val directory = newTestDirectory()
    private var reachable = true
    private var lastId = 0

    private fun TestScope.api(): AuthenticatedApi {
        val engine = MockEngine { request ->
            check(reachable) { "no network" }
            val body = when (request.url.encodedPath) {
                "/api/schema" -> KEPT_SCHEMA
                "/api/items/i1" -> KEPT_ITEM
                "/api/items/p1" -> KEPT_TARGET
                "/api/items/s1" -> KEPT_SERIES
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, headersOf("Content-Type", "application/json"))
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val layer = OfflineLayer(
            OfflineStore(directory, StandardTestDispatcher(testScheduler)),
            backgroundScope,
            TestTimeSource(),
            QueueClock(now = { "2026-11-23T10:00:00Z" }, random = { 0.0 }, today = { "2026-11-23" }),
            newId = { "made-${++lastId}" },
        )
        return AuthenticatedApi(ApiClient(engine), storage, offline = layer) {}
    }

    /** Reads the kept items while the server answers, then loses the connection. */
    private suspend fun AuthenticatedApi.offlineAfterReading() {
        send(HttpMethod.Get, "/api/schema")
        listOf("i1", "p1", "s1").forEach { send(HttpMethod.Get, "/api/items/$it") }
        reachable = false
    }

    @Test fun `a create answers the item with a made id and its properties and relations`() = runTest {
        val api = api()
        api.offlineAfterReading()
        val created = ItemWrites(api).create(
            "d1",
            buildJsonObject { put("name", "Task") },
            mapOf("project" to listOf("p1")),
        )
        val item = assertIs<RepositoryResult.Content<ItemDto>>(created).value
        assertEquals("made-1", item.id)
        assertEquals("d1", item.databaseId)
        assertEquals(JsonPrimitive("Task"), item.properties["name"])
        assertEquals(listOf("Garden"), item.relations.getValue("project").map { it.title })
    }

    @Test fun `a change answers the kept item with the change in it`() = runTest {
        val api = api()
        api.offlineAfterReading()
        val patched = ItemWrites(api).patch("i1", buildJsonObject { put("name", "New") }, "v1")
        val item = assertIs<RepositoryResult.Content<ItemDto>>(patched).value
        assertEquals(JsonPrimitive("New"), item.properties["name"])
        assertEquals(JsonPrimitive("Here"), item.properties["place"])
        assertEquals("2026-11-23T10:00:00Z", item.version)
    }

    @Test fun `a change of an item not kept answers it with the change alone`() = runTest {
        val api = api()
        reachable = false
        val patched = ItemWrites(api).patch("i9", buildJsonObject { put("name", "New") }, "v1")
        val item = assertIs<RepositoryResult.Content<ItemDto>>(patched).value
        assertEquals("i9", item.id)
        assertEquals(mapOf("name" to JsonPrimitive("New")), item.properties.toMap())
    }

    @Test fun `deletes and relations and value links answer as done`() = runTest {
        val api = api()
        reachable = false
        val writes = ItemWrites(api)
        assertEquals(RepositoryResult.Content(Unit), writes.delete("i1"))
        assertEquals(RepositoryResult.Content(Unit), writes.setRelation("i1", "project", "p1"))
        assertEquals(RepositoryResult.Content(Unit), writes.addRelation("i1", "people", "p2"))
        assertEquals(RepositoryResult.Content(Unit), writes.removeRelation("i1", "people", "p2"))
        assertEquals(RepositoryResult.Content(Unit), writes.changeValueLink("i1", "project", relink = true))
    }

    @Test fun `a new event and a repeating task answer their made ids`() = runTest {
        val api = api()
        api.offlineAfterReading()
        val calendar = HttpCalendarRepository(api, CalendarChanges())
        val schedule = CalendarSchedule(OFFLINE_DAY, null, ClockTime(600), ClockTime(660))
        val event = NewCalendarItem(CalendarEntryKind.EVENT, "Lunch", schedule, null, "cal-1", submissionKey = "k1")
        val eventId = assertIs<RepositoryResult.Content<String>>(calendar.create(event)).value
        val task = NewCalendarItem(
            CalendarEntryKind.TASK, "Water", schedule, null, null, repeat = CalendarRepeat.WEEKLY, submissionKey = "k2",
        )
        val taskId = assertIs<RepositoryResult.Content<String>>(calendar.create(task)).value
        assertTrue(eventId.startsWith("made-") && taskId.startsWith("made-") && eventId != taskId)
    }

    @Test fun `moving an occurrence of a series stores it on the device and changes it`() = runTest {
        val api = api()
        api.offlineAfterReading()
        val calendar = HttpCalendarRepository(api, CalendarChanges())
        val occurrence = CalendarEntry(
            "s1@2026-11-23", CalendarEntryKind.EVENT, "Standup", null, OFFLINE_DAY, null, ClockTime(540),
            ClockTime(570), ClockTime(570), false, null, null, readOnly = true, version = null, seriesId = "s1",
            occurrenceDate = OFFLINE_DAY,
        )
        val moved = CalendarSchedule(OFFLINE_DAY, null, ClockTime(600), ClockTime(630))
        assertEquals(RepositoryResult.Content(Unit), calendar.reschedule(occurrence, moved))
    }

    @Test fun `a duplicate is not queued and fails without a connection`() = runTest {
        val api = api()
        reachable = false
        val calendar = HttpCalendarRepository(api, CalendarChanges())
        val entry = CalendarEntry(
            "e1", CalendarEntryKind.EVENT, "Lunch", null, OFFLINE_DAY, null, null, null, null, true, null, null,
            readOnly = false, version = "v1",
        )
        val copied = calendar.duplicate(entry, CalendarSchedule(OFFLINE_DAY, null, null, null))
        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(copied).kind)
    }

    @Test fun `an answer to an invitation answers as done`() = runTest {
        val api = api()
        reachable = false
        val invitations = HttpInvitationRepository(api, CalendarChanges())
        assertEquals(RepositoryResult.Content(Unit), invitations.respond("inv-1", InvitationAnswer.ACCEPT))
    }

    @Test fun `the page of a diary period answers a made item id`() = runTest {
        val api = api()
        reachable = false
        val journal = HttpJournalRepository(api)
        val period = JournalPeriod(JournalPeriodType.DAY, "2026-11-23")
        assertEquals(RepositoryResult.Content("made-1"), journal.ensurePage(period))
    }

    @Test fun `a typed capture into the Inbox answers as done`() = runTest {
        val api = api()
        reachable = false
        val capture = InboxCapture(text = "Buy milk", day = OFFLINE_DAY, time = "10:00", typeId = null, file = null)
        assertEquals(RepositoryResult.Content(Unit), HttpInboxCaptureRepository(api).capture(capture))
    }
}
