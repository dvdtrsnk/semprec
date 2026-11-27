package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertSame

private const val EVENTS_DB = "db-events"
private const val TASKS_DB = "db-tasks"
private const val MONTH_FROM = "2026-11-01"
private const val MONTH_TO = "2026-11-30"
private val PROJECTION_DAY = CalendarDay(2026, 11, 23)

private fun pending(route: QueuedRoute, method: HttpMethod, path: String, body: String? = null, newId: String? = null) =
    PendingWrite(route, ApiRequest(method, path, body = body), newId, "2026-11-23T10:00:00Z")

/** A queued `PATCH` of the item [id] with the properties [properties] (a JSON object). */
private fun patchOf(id: String, properties: String) =
    pending(QueuedRoute.PATCH_ITEM, HttpMethod.Patch, "/api/items/$id", """{"properties":$properties}""")

private fun okAnswer(json: String) = ApiResponse.Success(200, json)

private fun parsed(json: String): JsonObject = ApiJson.parseToJsonElement(json).jsonObject

private fun ApiResponse.json(): JsonObject = parsed(assertIs<ApiResponse.Success>(this).body)

private fun JsonObject.items(): List<JsonObject> = getValue("items").jsonArray.map { it.jsonObject }

private fun ApiResponse.ids(): List<String?> = json().items().map { it.text("id") }

private fun ApiResponse.properties(): JsonObject = json().getValue("properties").jsonObject

private fun JsonElement.text(key: String): String? = (jsonObject[key] as? JsonPrimitive)?.takeIf {
    it.isString
}?.content

private fun timelineRead(from: String = MONTH_FROM, to: String = MONTH_TO) =
    ApiRequest(HttpMethod.Get, "/api/calendar/timeline", listOf("from" to from, "to" to to))

class QueuedWriteProjectionTest {
    private val made = parsed(
        """{"id":"n1","databaseId":"$TASKS_DB","properties":{"name":"Water","date":"2026-11-23","status":"notDone",
           "effectiveDate":"2026-11-23"},"relations":{},"version":"2026-11-23T10:00:00Z"}""",
    )

    private fun context(created: Map<String, JsonObject> = emptyMap(), titles: Map<String, String> = emptyMap()) =
        ProjectionContext(mapOf("events" to EVENTS_DB, "tasks" to TASKS_DB), PROJECTION_DAY, titles, created)

    private fun project(
        read: ApiRequest,
        answer: ApiResponse,
        vararg writes: PendingWrite,
        context: ProjectionContext = context(),
    ) = QueuedWriteProjection.apply(read, answer, writes.toList(), context)

    private val itemRead = ApiRequest(HttpMethod.Get, "/api/items/i1")
    private val keptItem = okAnswer(
        """{"id":"i1","databaseId":"db-x","properties":{"name":"Old","place":"Here"},"relations":{"people":[]}}""",
    )
    private val rename = patchOf("i1", """{"name":"New"}""")

    @Test fun `with nothing queued the answer is returned as it came`() {
        assertSame(keptItem, project(itemRead, keptItem))
    }

    @Test fun `an answer that is not JSON is returned as it came`() {
        val text = okAnswer("not json")
        assertSame(text, project(itemRead, text, rename))
    }

    @Test fun `a failed answer is returned as it came`() {
        val failure = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
        assertSame(failure, project(itemRead, failure, rename))
    }

    @Test fun `a write that changes nothing in the answer leaves it as it came`() {
        assertSame(keptItem, project(itemRead, keptItem, patchOf("i9", """{"name":"X"}""")))
    }

    @Test fun `a change sets its properties on every object of the item`() {
        val properties = project(itemRead, keptItem, rename, patchOf("i1", """{"place":null}""")).properties()
        assertEquals("New", properties.text("name"))
        assertEquals(JsonNull, properties["place"])
        val page =
            okAnswer("""{"items":[{"id":"i1","properties":{"name":"Old"}},{"id":"i2","properties":{"name":"B"}}]}""")
        val read = ApiRequest(HttpMethod.Post, "/api/databases/db-x/query", body = "{}")
        val names = project(read, page, rename).json().items().map { it.getValue("properties").text("name") }
        assertEquals(listOf("New", "B"), names)
    }

    @Test fun `a change of a task derives the day it was completed and the day it counts for`() {
        val task = okAnswer("""{"id":"i1","databaseId":"$TASKS_DB","properties":{"status":"notDone"}}""")
        val done = patchOf("i1", """{"status":"done"}""")
        assertEquals("2026-11-23", project(itemRead, task, done).properties().text("completedOn"))
        val open = patchOf("i1", """{"status":"notDone"}""")
        assertEquals(JsonNull, project(itemRead, task, done, open).properties()["completedOn"])
        val own = patchOf("i1", """{"status":"done","completedOn":"2026-11-20"}""")
        assertEquals("2026-11-20", project(itemRead, task, own).properties().text("completedOn"))
        val moved = patchOf("i1", """{"date":"2026-11-30"}""")
        assertEquals("2026-11-30", project(itemRead, task, moved).properties().text("effectiveDate"))
    }

    @Test fun `a change of an item that is no task derives nothing`() {
        val done = project(itemRead, keptItem, patchOf("i1", """{"status":"done"}"""))
        assertEquals(null, done.properties()["completedOn"])
    }

    @Test fun `a change sets the fields of the item's timeline and agenda entries`() {
        val timeline = okAnswer(
            """{"items":[{"kind":"event","id":"i1","title":"Old","date":"2026-11-23","timeFrom":"09:00"}]}""",
        )
        val moved = patchOf(
            "i1",
            """{"name":"New","date":"2026-11-24","timeFrom":"10:00","timeTo":"11:00","place":"Office"}""",
        )
        val entry = project(timelineRead(), timeline, moved).json().items().single()
        val fields = listOf("title", "date", "timeFrom", "timeTo", "place").map { entry.text(it) }
        assertEquals(listOf("New", "2026-11-24", "10:00", "11:00", "Office"), fields)
    }

    @Test fun `a reminder of a renamed item is renamed and one of a moved or completed item is left out`() {
        val read = ApiRequest(HttpMethod.Get, "/api/calendar/reminders")
        val reminders = okAnswer(
            """{"reminders":[{"key":"i1:x","itemId":"i1","kind":"event","title":"Old","fireAt":"x","startsAt":"y"}]}""",
        )
        val renamed = project(read, reminders, rename).json().getValue("reminders").jsonArray.single()
        assertEquals("New", renamed.text("title"))
        listOf(
            """{"date":"2026-11-24"}""",
            """{"timeFrom":"10:00"}""",
            """{"alertMinutes":5}""",
            """{"travelMinutes":5}""",
            """{"status":"done"}""",
            """{"status":"wontDo"}""",
        ).forEach { change ->
            val left = project(read, reminders, patchOf("i1", change)).json().getValue("reminders").jsonArray
            assertEquals(0, left.size, change)
        }
    }

    @Test fun `a delete leaves out the item and its entries and occurrences and reminders and the relations to it`() {
        val delete = pending(QueuedRoute.DELETE_ITEM, HttpMethod.Delete, "/api/items/i1")
        val timeline = okAnswer(
            """{"items":[{"kind":"event","id":"i1"},{"kind":"event","id":"i1@2026-11-24","seriesId":"i1"},
               {"kind":"task","id":"i2","title":"Stays"}],
               "reminders":[{"itemId":"i1","fireAt":"x"}],
               "other":{"id":"i3","properties":{},"relations":{"project":[{"id":"i1","title":"Gone"}]}}}""",
        )
        val projected = project(timelineRead(), timeline, delete).json()
        assertEquals(listOf("i2"), projected.items().map { it.text("id") })
        assertEquals(0, projected.getValue("reminders").jsonArray.size)
        val relations = projected.getValue("other").jsonObject.getValue("relations").jsonObject
        assertEquals(0, relations.getValue("project").jsonArray.size)
    }

    @Test fun `a deleted item answers not found`() {
        val delete = pending(QueuedRoute.DELETE_ITEM, HttpMethod.Delete, "/api/items/i1")
        val answer = assertIs<ApiResponse.Failure>(project(itemRead, keptItem, delete))
        assertEquals(404, answer.status)
        assertEquals(FailureKind.NOT_FOUND, answer.kind)
    }

    private val create = pending(
        QueuedRoute.CREATE_ITEM,
        HttpMethod.Post,
        "/api/databases/$TASKS_DB/items",
        """{"properties":{"name":"Water"}}""",
        "n1",
    )

    @Test fun `an item created on the device is answered as the device made it with later changes in it`() {
        val read = ApiRequest(HttpMethod.Get, "/api/items/n1")
        val unreachable = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
        val renamed = patchOf("n1", """{"name":"Plants"}""")
        val answer = project(read, unreachable, create, renamed, context = context(mapOf("n1" to made)))
        assertEquals("n1", answer.json().text("id"))
        assertEquals("Plants", answer.properties().text("name"))
    }

    @Test fun `a created item joins the first page of its database's queries that its filter matches`() {
        val created = context(mapOf("n1" to made))
        val page = okAnswer(
            """{"items":[{"id":"t0","properties":{"date":"2026-11-20"}},
               {"id":"t9","properties":{"date":"2026-12-01"}}]}""",
        )
        fun query(body: String) = ApiRequest(HttpMethod.Post, "/api/databases/$TASKS_DB/query", body = body)
        fun ids(
            body: String,
            answer: ApiResponse = page
        ) = project(query(body), answer, create, context = created).ids()

        val open = """{"type":"equals","property":"status","value":"notDone"}"""
        val ascending = """{"filter":$open,"sort":[{"property":"date","direction":"asc"}]}"""
        assertEquals(listOf("t0", "n1", "t9"), ids(ascending))
        val newestFirst = okAnswer(
            """{"items":[{"id":"t9","properties":{"date":"2026-12-01"}},
               {"id":"t0","properties":{"date":"2026-11-20"}}]}""",
        )
        val descending = """{"sort":[{"property":"date","direction":"desc"}]}"""
        assertEquals(listOf("t9", "n1", "t0"), ids(descending, newestFirst))
        assertEquals(listOf("t0", "t9", "n1"), ids("{}"))
        assertEquals(listOf("t0", "t9", "n1"), ids("""{"sort":[{"property":"points","direction":"asc"}]}"""))
        val done = """{"filter":{"type":"equals","property":"status","value":"done"}}"""
        assertSame(page, project(query(done), page, create, context = created))
        listOf("""{"cursor":"c2"}""", """{"q":"wat"}""", """{"inTrash":true}""").forEach { body ->
            assertSame(page, project(query(body), page, create, context = created), body)
        }
        val otherDatabase = ApiRequest(HttpMethod.Post, "/api/databases/db-other/query", body = "{}")
        assertSame(page, project(otherDatabase, page, create, context = created))
    }

    @Test fun `a created event or task joins the timeline that holds its day`() {
        val lunch = parsed("""{"name":"Lunch","date":"2026-11-23","timeFrom":"12:00","timeTo":"13:00"}""")
        val event = JsonObject(
            made + mapOf(
                "databaseId" to JsonPrimitive(EVENTS_DB),
                "relations" to parsed("""{"calendar":[{"id":"cal-1","title":"Work"}]}"""),
                "properties" to lunch,
            ),
        )
        val events = context(mapOf("n1" to event))
        val createEvent =
            pending(QueuedRoute.CREATE_ITEM, HttpMethod.Post, "/api/databases/$EVENTS_DB/items", "{}", "n1")
        val timeline = okAnswer(
            """{"items":[{"kind":"event","id":"e1","date":"2026-11-23","timeFrom":"08:00"},
               {"kind":"event","id":"e2","date":"2026-11-24"}]}""",
        )
        val entries = project(timelineRead(), timeline, createEvent, context = events).json().items()
        assertEquals(listOf("e1", "n1", "e2"), entries.map { it.text("id") })
        val entry = entries[1]
        val fields = listOf("kind", "title", "timeFrom", "timeTo", "effectiveTo", "calendarId").map { entry.text(it) }
        assertEquals(listOf("event", "Lunch", "12:00", "13:00", "13:00", "cal-1"), fields)
        assertEquals(JsonPrimitive(false), entry["allDay"])
        assertEquals(JsonPrimitive(false), entry["readOnly"])
        assertSame(timeline, project(timelineRead("2026-12-01", "2026-12-31"), timeline, createEvent, context = events))
        val tasks = project(timelineRead(), timeline, create, context = context(mapOf("n1" to made))).json().items()
        val task = tasks.single { it.text("id") == "n1" }
        assertEquals("task", task.text("kind"))
        assertEquals("notDone", task.text("status"))
        assertEquals(JsonPrimitive(true), task["allDay"])
    }

    @Test fun `an item of another database joins no timeline`() {
        val createNote = pending(QueuedRoute.CREATE_ITEM, HttpMethod.Post, "/api/databases/db-notes/items", "{}", "n1")
        val timeline = okAnswer("""{"items":[]}""")
        assertSame(timeline, project(timelineRead(), timeline, createNote, context = context(mapOf("n1" to made))))
    }

    @Test fun `a created item joins the first page of the agenda from its day only`() {
        val created = context(mapOf("n1" to made))
        val agenda = okAnswer("""{"items":[{"kind":"task","id":"t1","date":"2026-11-22"}]}""")
        fun read(
            vararg query: Pair<String, String>
        ) = ApiRequest(HttpMethod.Get, "/api/calendar/agenda", query.toList())
        assertEquals(listOf("t1", "n1"), project(read("from" to "2026-11-20"), agenda, create, context = created).ids())
        assertSame(agenda, project(read("from" to "2026-11-24"), agenda, create, context = created))
        assertSame(agenda, project(read("from" to "2026-11-20", "cursor" to "c2"), agenda, create, context = created))
        val more = okAnswer("""{"items":[{"kind":"task","id":"t1","date":"2026-11-22"}],"nextCursor":"c2"}""")
        assertSame(more, project(read("from" to "2026-11-20"), more, create, context = created))
    }

    @Test fun `relations added or removed or set show on the item`() {
        val titles = context(titles = mapOf("p1" to "Garden", "p2" to "House"))
        fun people(vararg writes: PendingWrite): List<Pair<String?, String?>> {
            val relations = project(itemRead, keptItem, *writes, context = titles).json().getValue("relations")
            return relations.jsonObject.getValue("people").jsonArray.map { it.text("id") to it.text("title") }
        }
        fun set(body: String) =
            pending(QueuedRoute.SET_RELATION, HttpMethod.Put, "/api/items/i1/relations/people", body)
        val add = pending(QueuedRoute.ADD_RELATION, HttpMethod.Put, "/api/items/i1/relations/people/p1")
        assertEquals(listOf("p1" to "Garden"), people(add))
        val remove = pending(QueuedRoute.REMOVE_RELATION, HttpMethod.Delete, "/api/items/i1/relations/people/p1")
        assertEquals(emptyList(), people(add, remove))
        assertEquals(listOf("p2" to "House"), people(add, set("""{"targetItemId":"p2"}""")))
        assertEquals(emptyList(), people(add, set("""{"targetItemId":null}""")))
        assertEquals(listOf("p1" to "Garden", "p2" to "House"), people(set("""{"targetItemIds":["p1","p2"]}""")))
        val unknown = pending(QueuedRoute.ADD_RELATION, HttpMethod.Put, "/api/items/i1/relations/people/p9")
        assertEquals(listOf("p9" to ""), people(unknown))
    }

    @Test fun `a stored occurrence takes its new id and stops being read only`() {
        val store = pending(
            QueuedRoute.OCCURRENCE,
            HttpMethod.Post,
            "/api/events/series/s1/occurrences/2026-11-24",
            newId = "n7",
        )
        val timeline = okAnswer(
            """{"items":[
               {"kind":"event","id":"s1@2026-11-24","seriesId":"s1","occurrenceDate":"2026-11-24","readOnly":true},
               {"kind":"event","id":"s1@2026-11-25","seriesId":"s1","occurrenceDate":"2026-11-25","readOnly":true}]}""",
        )
        val entries = project(timelineRead(), timeline, store).json().items()
        assertEquals(listOf("n7", "s1@2026-11-25"), entries.map { it.text("id") })
        assertEquals(listOf(JsonPrimitive(false), JsonPrimitive(true)), entries.map { it["readOnly"] })
    }

    @Test fun `an answered invitation shows its new status`() {
        val answer = pending(
            QueuedRoute.INVITATION_ANSWER,
            HttpMethod.Post,
            "/api/calendar/invitations/v1/respond",
            """{"response":"declined"}""",
        )
        val page = okAnswer("""{"items":[{"id":"v1","properties":{"status":"pending","title":"Party"}}]}""")
        val read = ApiRequest(HttpMethod.Post, "/api/databases/db-inv/query", body = "{}")
        val invitation = project(read, page, answer).json().items().single()
        assertEquals("declined", invitation.getValue("properties").text("status"))
    }

    @Test fun `writes that the answers do not show change nothing`() {
        listOf(
            pending(QueuedRoute.VALUE_LINK, HttpMethod.Post, "/api/items/i1/links/project/unlink"),
            pending(QueuedRoute.SET_TASK_RECURRENCE, HttpMethod.Put, "/api/tasks/i1/recurrence", """{"preset":"a"}"""),
            pending(QueuedRoute.CLEAR_TASK_RECURRENCE, HttpMethod.Delete, "/api/tasks/i1/recurrence"),
            pending(QueuedRoute.HOST_EVENT, HttpMethod.Put, "/api/tasks/i1/host-events/e1"),
            pending(QueuedRoute.PERIOD_PAGE, HttpMethod.Put, "/api/journal/periods/day/2026-11-23/doc", newId = "n2"),
        ).forEach { write -> assertSame(keptItem, project(itemRead, keptItem, write)) }
    }

    @Test fun `a change without properties changes nothing`() {
        val bare = pending(QueuedRoute.PATCH_ITEM, HttpMethod.Patch, "/api/items/i1", """{"ifVersion":"v1"}""")
        assertSame(keptItem, project(itemRead, keptItem, bare))
    }
}
