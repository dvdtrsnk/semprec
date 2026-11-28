package cz.alldots.app.data

import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.ItemKind
import cz.alldots.app.core.StoredSession
import cz.alldots.app.core.TaskStatus
import cz.alldots.app.domain.CalendarChanges
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.CalendarSchedule
import cz.alldots.app.domain.CalendarWindow
import cz.alldots.app.domain.ClockTime
import cz.alldots.app.domain.ItemChange
import cz.alldots.app.domain.NewCalendarItem
import cz.alldots.app.domain.NewTask
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.TaskScope
import cz.alldots.app.domain.WorkItem
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.TestTimeSource

private const val VIEW_TODAY = "2026-11-23"
private val VIEW_DAY = CalendarDay(2026, 11, 23)
private const val VIEW_DATABASES = """{"databases":[{"id":"db-tasks","key":"tasks"},{"id":"db-events","key":"events"},
    {"id":"db-projects","key":"projects"},{"id":"db-cal","key":"calendars"}]}"""
private const val VIEW_SCHEMA = """{"databases":[{"databaseId":"db-tasks","key":"tasks"},
    {"databaseId":"db-events","key":"events"},{"databaseId":"db-projects","key":"projects"},
    {"databaseId":"db-cal","key":"calendars"}]}"""
private const val VIEW_TASK = """{"id":"t1","databaseId":"db-tasks","version":"v1",
    "properties":{"name":"Call","status":"notDone","date":"$VIEW_TODAY",
    "effectiveDate":"$VIEW_TODAY"},"relations":{}}"""
private const val VIEW_TIMELINE = """{"timezone":"Europe/Prague","today":"$VIEW_TODAY",
    "now":{"date":"$VIEW_TODAY","time":"08:00"},"from":"2026-11-01","to":"2026-11-30","items":[{"kind":"event","id":"e1","title":"Standup","date":"$VIEW_TODAY",
    "timeFrom":"09:00","timeTo":"09:30","version":"v1"}]}"""

/** A write made without a connection is what the next read of the repositories shows. */
@OptIn(ExperimentalCoroutinesApi::class)
class QueuedViewsRepositoryTest {
    private val directory = newTestDirectory()
    private var reachable = true
    private var lastId = 0

    private fun TestScope.api(): AuthenticatedApi {
        val engine = MockEngine { request ->
            check(reachable) { "no network" }
            val body = when (request.url.encodedPath) {
                "/api/databases" -> VIEW_DATABASES
                "/api/schema" -> VIEW_SCHEMA
                "/api/databases/db-tasks/query" -> """{"items":[$VIEW_TASK]}"""
                "/api/databases/db-projects/query" -> """{"items":[]}"""
                "/api/databases/db-cal/query" -> """{"items":[]}"""
                "/api/items/t1" -> VIEW_TASK
                "/api/calendar/timeline" -> VIEW_TIMELINE
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, headersOf("Content-Type", "application/json"))
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val layer = OfflineLayer(
            OfflineStore(directory, StandardTestDispatcher(testScheduler)),
            backgroundScope,
            TestTimeSource(),
            QueueClock(now = { "2026-11-23T10:00:00Z" }, random = { 0.0 }, today = { VIEW_TODAY }),
            newId = { "made-${++lastId}" },
        )
        return AuthenticatedApi(ApiClient(engine), storage, offline = layer) {}
    }

    private fun <T> RepositoryResult<T>.content(): T = assertIs<RepositoryResult.Content<T>>(this).value

    /** Reads the schema as the sync socket does on every connect, so the device knows the databases by key. */
    private suspend fun AuthenticatedApi.connected() {
        send(HttpMethod.Get, "/api/schema")
    }

    private suspend fun HttpCalendarRepository.month(): CalendarWindow =
        window(CalendarDay(2026, 11, 1), CalendarDay(2026, 11, 30)).content()

    @Test fun `a task created and one completed offline show in the task lists and the detail`() = runTest {
        val api = api()
        api.connected()
        val work = WorkData(api)
        work.tasks.tasks(TaskScope.TODAY).content()
        val call = work.details.load(ItemKind.TASK, "t1").content()
        reachable = false

        val water = work.tasks.create(NewTask("Water", VIEW_TODAY, null)).content()
        assertEquals("Water", water.title)
        work.details.update(call, ItemChange.Done(true)).content()

        val today = work.tasks.tasks(TaskScope.TODAY).content()
        assertEquals(setOf("Call", "Water"), today.map(WorkItem::title).toSet())
        assertEquals(TaskStatus.DONE, today.single { it.id == "t1" }.status)
        assertEquals(TaskStatus.DONE, work.details.load(ItemKind.TASK, "t1").content().status)
        assertEquals("Water", work.details.load(ItemKind.TASK, water.id).content().title)
    }

    @Test fun `a task only listed before going offline is completed and renamed and opens`() = runTest {
        val api = api()
        api.connected()
        val work = WorkData(api)
        val listed = work.tasks.tasks(TaskScope.TODAY).content().single { it.id == "t1" }
        reachable = false

        val done = work.details.update(listed, ItemChange.Done(true)).content()
        val renamed = work.details.update(done, ItemChange.Title("Call back")).content()

        assertEquals(TaskStatus.DONE, done.status)
        assertEquals("Call back", renamed.title)
        val opened = work.details.load(ItemKind.TASK, "t1").content()
        assertEquals(TaskStatus.DONE to "Call back", opened.status to opened.title)
    }

    @Test fun `a task renamed offline shows its new name`() = runTest {
        val api = api()
        val work = WorkData(api)
        val call = work.details.load(ItemKind.TASK, "t1").content()
        reachable = false
        val renamed = work.details.update(call, ItemChange.Title("Call back")).content()
        assertEquals("Call back", renamed.title)
    }

    @Test fun `a project created offline joins the projects and one deleted offline leaves them`() = runTest {
        val api = api()
        val work = WorkData(api)
        work.catalog.projects().content()
        reachable = false
        val garden = buildJsonObject { put("name", "Garden") }
        val created = ItemWrites(api).create("db-projects", garden, emptyMap()).content()
        assertEquals(listOf("Garden"), work.catalog.projects().content().map { it.title })
        ItemWrites(api).delete(created.id).content()
        assertTrue(work.catalog.projects().content().isEmpty())
    }

    @Test fun `an event moved or created or deleted offline shows so in the calendar`() = runTest {
        val api = api()
        api.connected()
        val calendar = HttpCalendarRepository(api, CalendarChanges())
        val standup = calendar.month().timeline.entries.single { it.id == "e1" }
        reachable = false

        calendar.reschedule(standup, CalendarSchedule(VIEW_DAY, null, ClockTime(600), ClockTime(630))).content()
        val moved = calendar.month().timeline.entries.single { it.id == "e1" }
        assertEquals(ClockTime(600), moved.timeFrom)

        val noon = CalendarSchedule(VIEW_DAY, null, ClockTime(720), ClockTime(780))
        val draft = NewCalendarItem(CalendarEntryKind.EVENT, "Lunch", noon, null, null, submissionKey = "k1")
        val lunch = calendar.create(draft).content()
        val entries = calendar.month().timeline.entries
        assertEquals(listOf("e1", lunch), entries.map(CalendarEntry::id))
        assertEquals("Lunch", entries.last().title)

        calendar.delete(moved).content()
        assertEquals(listOf(lunch), calendar.month().timeline.entries.map(CalendarEntry::id))
    }
}
