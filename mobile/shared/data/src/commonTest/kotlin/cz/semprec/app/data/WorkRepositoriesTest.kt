package cz.semprec.app.data

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.LinkState
import cz.semprec.app.core.LinkedValue
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.core.StoredSession
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.NewTask
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.TaskScope
import cz.semprec.app.domain.WorkItem
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SERVER = "https://s.example"
private const val TASKS_ID = "11111111-1111-4111-8111-111111111111"
private const val TASK_ID = "22222222-2222-4222-8222-222222222222"
private const val DATABASES = """{"databases":[
    {"id":"$TASKS_ID","key":"tasks"},{"id":"db-events","key":"events"},
    {"id":"db-projects","key":"projects"},{"id":"db-people","key":"people"}]}"""
private const val BARE_TASK = """{"id":"$TASK_ID","databaseId":"$TASKS_ID"}"""
private const val TASK_JSON = """{"id":"$TASK_ID","databaseId":"$TASKS_ID",
    "updatedAt":"2026-10-16T08:00:00.000Z","version":"1","properties":{
    "name":"Odeslat fakturu","status":"notDone","date":"2026-10-13","effectiveDate":"2026-10-16",
    "timeFrom":"14:00","timeTo":"15:30","flagged":true,"description":"Za zari",
    "recurrence":{"preset":"daily","mode":"fixed"}},
    "relations":{
      "project":[{"id":"p1","title":"Ucetnictvi","color":"#8E8E93"}],
      "people":[{"id":"u1","title":"Karel Zlaty"},{"id":"u2","hidden":true}],
      "files":[{"id":"f1","title":"Faktura.pdf"}],
      "hostEvents":[{"id":"e1","title":"Zubar"}]},
    "links":{"project":{"valueKind":"inheritedBroken","sources":[{"kind":"item","itemId":"e1","title":"Schuzka"}],
      "brokenBy":"agent"},"people":{"valueKind":"inherited","sources":[{"kind":"item","title":"Schuzka"}]}}}"""

class WorkRepositoriesTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun work(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): WorkData {
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        val storage = InMemorySessionStorage().apply { save(StoredSession(SERVER, "tok")) }
        return WorkData(AuthenticatedApi(ApiClient(engine), storage, onSessionRejected = {}))
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun routes(request: HttpRequestData): String = "${request.method.value} ${request.url.encodedPath}"

    private suspend fun MockRequestHandleScope.standard(request: HttpRequestData): HttpResponseData =
        when (request.url.encodedPath) {
            "/api/databases" -> json(DATABASES)
            "/api/databases/$TASKS_ID/query" -> json("""{"items":[$TASK_JSON]}""")
            "/api/databases/$TASKS_ID/items" ->
                json("""{"id":"$TASK_ID","databaseId":"$TASKS_ID"}""", HttpStatusCode.Created)
            "/api/databases/db-projects/query" -> json(
                """{"items":[
                {"id":"p2","databaseId":"db-projects","properties":{"name":"Zeta","status":"inProgress"}},
                {"id":"p1","databaseId":"db-projects","properties":{"name":"Alfa","status":"longTerm","color":"#007AFF"}},
                {"id":"p3","databaseId":"db-projects","properties":{"name":"Hotovy","status":"done"}},
                {"id":"p4","databaseId":"db-projects","properties":{"name":"Kalendar","systemActive":true}}]}""",
            )
            "/api/databases/db-people/query" -> json(
                """{"items":[{"id":"u2","databaseId":"x","properties":{"name":"Zora"}},
                {"id":"u1","databaseId":"x","properties":{"name":"Adam"}}]}""",
            )
            "/api/items/$TASK_ID" ->
                if (request.method.value == "GET") json(TASK_JSON) else json(BARE_TASK)
            else -> json("""{}""")
        }

    private suspend fun loaded(data: WorkData): WorkItem =
        assertIs<RepositoryResult.Content<WorkItem>>(data.details.load(ItemKind.TASK, TASK_ID)).value

    @Test
    fun theTodayListAsksForVisibleTasksOfToday() = runTest {
        val data = work { standard(it) }

        val tasks = assertIs<RepositoryResult.Content<List<WorkItem>>>(data.tasks.tasks(TaskScope.TODAY)).value

        assertEquals(1, tasks.size)
        val query = Json.parseToJsonElement(bodies.last()).jsonObject
        val filter = query.getValue("filter").jsonObject
        assertEquals("and", filter.getValue("type").jsonPrimitive.content)
        val text = filter.toString()
        assertTrue("\"hiddenUntil\"" in text && "completedInEvent" in text && "\"effectiveDate\"" in text)
        assertTrue("\"completedOn\"" in text && "\"today\"" in text)
        val project = query.getValue("include").jsonObject.getValue("relations").jsonObject.getValue("project")
        assertTrue(project.jsonArray.isEmpty())
    }

    @Test
    fun thePlannedAndAllListsAskForOpenTasksAndTasksDoneToday() = runTest {
        val data = work { standard(it) }

        data.tasks.tasks(TaskScope.PLANNED)
        data.tasks.tasks(TaskScope.ALL)

        val planned = bodies[1]
        val all = bodies[2]
        assertTrue("\"is_not_empty\"" in planned && "notDone" in planned && "completedOn" in planned)
        assertTrue("\"is_not_empty\"" !in all && "notDone" in all && "completedOn" in all)
    }

    @Test
    fun aTaskIsMappedWithItsProjectPeopleAndLinks() = runTest {
        val data = work { standard(it) }

        val task = loaded(data)

        assertEquals("Odeslat fakturu", task.title)
        assertEquals("1", task.version)
        assertEquals(Schedule("2026-10-13", "14:00", "15:30", null), task.schedule)
        assertEquals("2026-10-16", task.effectiveDate)
        assertEquals(TaskStatus.NOT_DONE, task.status)
        assertEquals(TaskRepeat.DAILY, task.repeat)
        assertTrue(task.flagged)
        assertEquals("Za zari", task.description)
        assertEquals(ProjectRef("p1", "Ucetnictvi", "#8E8E93"), task.project)
        assertEquals(listOf("Karel Zlaty"), task.people.map { it.title })
        assertEquals(listOf("Faktura.pdf"), task.files.map { it.title })
        assertEquals(listOf("Zubar"), task.hostEvents.map { it.title })
        assertEquals(LinkState.BROKEN, task.projectLink?.state)
        assertTrue(task.projectLink?.brokenBySemp == true)
        assertEquals("Schuzka", task.projectLink?.sourceTitle)
        assertEquals(LinkState.INHERITED, task.peopleLink?.state)
        val url = requests.last().url
        assertEquals("links,relations", url.parameters["include"])
        assertEquals("", url.parameters["relations.project"])
    }

    @Test
    fun aTaskWithoutRecurrenceOrWithACustomRuleAndAnUnknownStatusIsMappedSafely() = runTest {
        val plain = """{"id":"t","databaseId":"d","properties":{"name":"A","status":"strange"}}"""
        val custom = """{"id":"t","databaseId":"d","properties":{"name":"A","recurrence":{"rule":{}}}}"""
        var answer = plain
        val data = work { json(answer) }

        val first = loaded(data)
        answer = custom
        val second = loaded(data)

        assertEquals(TaskRepeat.NONE, first.repeat)
        assertEquals(TaskStatus.NOT_DONE, first.status)
        assertNull(first.project)
        assertEquals(TaskRepeat.CUSTOM, second.repeat)
    }

    @Test
    fun anEventIsMappedWithItsPlaceCompanyAndAllDayShape() = runTest {
        val event = """{"id":"e","databaseId":"d","version":"2","properties":{"name":"Zubar","date":"2026-10-15",
            "endDate":"2026-10-16","place":"Praha"},"relations":{"company":[{"id":"c","title":"Firma"}]}}"""
        val data = work { json(event) }

        val item = assertIs<RepositoryResult.Content<WorkItem>>(data.details.load(ItemKind.EVENT, "e")).value

        assertEquals(ItemKind.EVENT, item.kind)
        assertEquals("Praha", item.place)
        assertEquals("Firma", item.company?.title)
        assertEquals(Schedule("2026-10-15", null, null, "2026-10-16"), item.schedule)
        assertEquals("", requests.single().url.parameters["relations.company"])
    }

    @Test
    fun createAddsATaskForTodayInTheProjectAndReadsItBack() = runTest {
        val data = work { standard(it) }

        val created = data.tasks.create(NewTask("Nova", "2026-10-16", "p1"))

        assertEquals("Odeslat fakturu", assertIs<RepositoryResult.Content<WorkItem>>(created).value.title)
        val post = requests.indexOfFirst { it.method.value == "POST" && it.url.encodedPath.endsWith("/items") }
        val sent = Json.parseToJsonElement(bodies[post]).jsonObject
        val properties = sent.getValue("properties").jsonObject
        assertEquals("Nova", properties.getValue("name").jsonPrimitive.content)
        assertEquals("notDone", properties.getValue("status").jsonPrimitive.content)
        assertEquals("2026-10-16", properties.getValue("date").jsonPrimitive.content)
        val relation = sent.getValue("relations").jsonArray.single().jsonObject
        assertEquals("project", relation.getValue("propertyKey").jsonPrimitive.content)
        assertEquals("GET", requests.last().method.value)
    }

    @Test
    fun createWithoutADateOrProjectSendsNeither() = runTest {
        val data = work { standard(it) }

        data.tasks.create(NewTask("Nova", null, null))

        val sent = Json.parseToJsonElement(bodies.first { it.contains("\"properties\"") }).jsonObject
        assertTrue("date" !in sent.getValue("properties").jsonObject)
        assertTrue("relations" !in sent)
    }

    @Test
    fun everyChangeIsWrittenWithTheVersionAndTheItemIsReadAgain() = runTest {
        val data = work { standard(it) }
        val task = loaded(data)
        requests.clear()
        bodies.clear()

        val changes = listOf(
            ItemChange.Title("Nove"),
            ItemChange.Done(true),
            ItemChange.Done(false),
            ItemChange.Description("D"),
            ItemChange.Place("P"),
            ItemChange.Flagged(false),
            ItemChange.Reschedule(Schedule(null, null, null)),
            ItemChange.Project("p9"),
            ItemChange.Project(null),
            ItemChange.AddPerson("u9"),
            ItemChange.RemovePerson("u1"),
            ItemChange.RemoveFile("f1"),
            ItemChange.Unlink(LinkedValue.PROJECT),
            ItemChange.Relink(LinkedValue.PEOPLE),
            ItemChange.Repeat(TaskRepeat.NONE),
            ItemChange.Repeat(TaskRepeat.WEEKLY),
        )
        changes.forEach { assertIs<RepositoryResult.Content<WorkItem>>(data.details.update(task, it)) }

        val writes = requests.filter { it.method.value != "GET" }.map { routes(it) }
        assertEquals(
            listOf(
                "PATCH /api/items/$TASK_ID", "PATCH /api/items/$TASK_ID", "PATCH /api/items/$TASK_ID",
                "PATCH /api/items/$TASK_ID", "PATCH /api/items/$TASK_ID", "PATCH /api/items/$TASK_ID",
                "PATCH /api/items/$TASK_ID",
                "PUT /api/items/$TASK_ID/relations/project", "PUT /api/items/$TASK_ID/relations/project",
                "PUT /api/items/$TASK_ID/relations/people/u9", "DELETE /api/items/$TASK_ID/relations/people/u1",
                "DELETE /api/items/$TASK_ID/relations/files/f1",
                "POST /api/items/$TASK_ID/links/project/unlink", "POST /api/items/$TASK_ID/links/people/relink",
                "DELETE /api/tasks/$TASK_ID/recurrence", "PUT /api/tasks/$TASK_ID/recurrence",
            ),
            writes,
        )
        assertEquals(changes.size, requests.count { it.method.value == "GET" }, "Each write reads the item again")
        val patches = requests.indices.filter {
            requests[it].method.value == "PATCH"
        }.map { Json.parseToJsonElement(bodies[it]).jsonObject }
        assertTrue(patches.all { it.getValue("ifVersion").jsonPrimitive.content == "1" })
        fun JsonObject.props() = getValue("properties").jsonObject
        assertEquals("Nove", patches[0].props().getValue("name").jsonPrimitive.content)
        assertEquals("done", patches[1].props().getValue("status").jsonPrimitive.content)
        assertEquals("notDone", patches[2].props().getValue("status").jsonPrimitive.content)
        assertEquals("D", patches[3].props().getValue("description").jsonPrimitive.content)
        assertEquals("P", patches[4].props().getValue("place").jsonPrimitive.content)
        assertEquals("false", patches[5].props().getValue("flagged").jsonPrimitive.content)
        val cleared = patches[6].props()
        assertEquals(setOf("date", "timeFrom", "timeTo"), cleared.keys)
        assertTrue(cleared.values.all { it.toString() == "null" })
        val preset = requests.indices.last { requests[it].method.value == "PUT" }
        val sentPreset = Json.parseToJsonElement(bodies[preset]).jsonObject.getValue("preset")
        assertEquals("weekly", sentPreset.jsonPrimitive.content)
    }

    @Test
    fun anEventScheduleAlsoWritesTheEndDayAndACustomRepeatIsRefused() = runTest {
        val data = work { standard(it) }
        val task = loaded(data)
        val event = task.copy(kind = ItemKind.EVENT)
        requests.clear()
        bodies.clear()

        data.details.update(event, ItemChange.Reschedule(Schedule("2026-10-16", null, null, "2026-10-18")))
        val refused = data.details.update(task, ItemChange.Repeat(TaskRepeat.CUSTOM))

        val props = Json.parseToJsonElement(bodies.first()).jsonObject.getValue("properties").jsonObject
        assertEquals("2026-10-18", props.getValue("endDate").jsonPrimitive.content)
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(refused).kind)
    }

    @Test
    fun aRejectedWriteIsAFailureAndTheItemIsNotReadAgain() = runTest {
        val data = work { request ->
            when (request.method.value) {
                "PATCH" -> json("""{"error":"stale"}""", HttpStatusCode.Conflict)
                else -> standard(request)
            }
        }
        val task = loaded(data)
        requests.clear()

        val result = data.details.update(task, ItemChange.Title("X"))

        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
        assertEquals(1, requests.size)
    }

    @Test
    fun anOccurrenceOfASeriesReadsAsTheSeriesOnItsDayUnderItsOwnId() = runTest {
        val series = """{"id":"s1","databaseId":"d","version":"4","properties":{"name":"Svatek","date":"2026-01-10",
            "endDate":"2026-01-11"}}"""
        val data = work { json(series) }

        val loaded = data.details.load(ItemKind.EVENT, "s1@2026-11-24")
        val item = assertIs<RepositoryResult.Content<WorkItem>>(loaded).value

        assertEquals("GET /api/items/s1", routes(requests.single()))
        assertEquals("s1@2026-11-24", item.id)
        assertEquals("Svatek", item.title)
        assertEquals(Schedule("2026-11-24", null, null, "2026-11-25"), item.schedule)
    }

    @Test
    fun aChangeToAnOccurrenceStoresItFirstAndChangesTheStoredRow() = runTest {
        val stored = """{"id":"o1","databaseId":"d","version":"1","properties":{"name":"Svatek","date":"2026-11-24"}}"""
        val data = work { request ->
            when (routes(request)) {
                "POST /api/events/series/s1/occurrences/2026-11-24" -> json(stored, HttpStatusCode.Created)
                else -> json(stored)
            }
        }
        val occurrence = WorkItem(ItemKind.EVENT, "s1@2026-11-24", "4", "Svatek", Schedule("2026-11-24", null, null))

        val item = assertIs<RepositoryResult.Content<WorkItem>>(
            data.details.update(occurrence, ItemChange.Title("Oslava")),
        ).value

        assertEquals(
            listOf(
                "POST /api/events/series/s1/occurrences/2026-11-24",
                "PATCH /api/items/o1",
                "GET /api/items/o1",
            ),
            requests.map(::routes),
        )
        // The write names the stored row's version, not the series'.
        assertTrue(bodies[1].contains("\"ifVersion\":\"1\""))
        assertEquals("o1", item.id)
    }

    @Test
    fun deletingAnOccurrenceStoresItAndDeletesTheStoredRow() = runTest {
        val data = work { request ->
            when (routes(request)) {
                "POST /api/tasks/series/s1/occurrences/2026-11-24" ->
                    json("""{"id":"o1","databaseId":"d","version":"1"}""", HttpStatusCode.Created)
                else -> json("{}")
            }
        }

        assertIs<RepositoryResult.Content<Unit>>(data.details.delete(ItemKind.TASK, "s1@2026-11-24"))

        assertEquals(
            listOf("POST /api/tasks/series/s1/occurrences/2026-11-24", "DELETE /api/items/o1"),
            requests.map(::routes),
        )
    }

    @Test
    fun anOccurrenceThatCannotBeStoredIsThatFailure() = runTest {
        val data = work { json("{}", HttpStatusCode.ServiceUnavailable) }
        val occurrence = WorkItem(ItemKind.EVENT, "s1@2026-11-24", "4", "Svatek", Schedule("2026-11-24", null, null))

        assertIs<RepositoryResult.Failure>(data.details.update(occurrence, ItemChange.Title("Oslava")))
        assertEquals(listOf("POST /api/events/series/s1/occurrences/2026-11-24"), requests.map(::routes))
    }

    @Test
    fun deleteTrashesTheItem() = runTest {
        val data = work { standard(it) }

        assertIs<RepositoryResult.Content<Unit>>(data.details.delete(ItemKind.TASK, TASK_ID))

        assertEquals("DELETE /api/items/$TASK_ID", routes(requests.single()))
    }

    @Test
    fun theCatalogsAreSortedAndLeaveOutWhatIsHiddenClosedOrKeptByAModule() = runTest {
        val data = work { standard(it) }

        val projects = assertIs<RepositoryResult.Content<List<ProjectRef>>>(data.catalog.projects()).value
        val people = assertIs<RepositoryResult.Content<List<EntityRef>>>(data.catalog.people()).value

        assertEquals(listOf(ProjectRef("p1", "Alfa", "#007AFF"), ProjectRef("p2", "Zeta")), projects)
        assertEquals(listOf("Adam", "Zora"), people.map { it.title })
    }

    @Test
    fun aFailedReadIsThatFailure() = runTest {
        val data = work { json("""{}""", HttpStatusCode.Unauthorized) }

        val kinds = listOf(
            assertIs<RepositoryResult.Failure>(data.tasks.tasks(TaskScope.ALL)).kind,
            assertIs<RepositoryResult.Failure>(data.catalog.projects()).kind,
            assertIs<RepositoryResult.Failure>(data.details.load(ItemKind.TASK, "x")).kind,
        )
        assertEquals(List(3) { FailureKind.UNAUTHORIZED }, kinds)
    }
}
