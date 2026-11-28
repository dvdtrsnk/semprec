package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.ItemKind
import cz.alldots.app.core.MeetingTaskStatus
import cz.alldots.app.domain.ItemChange
import cz.alldots.app.domain.ItemRepository
import cz.alldots.app.domain.MeetingSuggestion
import cz.alldots.app.domain.MeetingTask
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.Schedule
import cz.alldots.app.domain.WorkItem
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val MEETING_TASKS_DB = "db-tasks"

private const val CREATED = """{"id":"new","databaseId":"db-tasks","properties":{},"version":"1"}"""

private const val MEETING_TASKS = """{"eventId":"e1","tasks":[
 {"taskId":"t1","title":"Open","state":{"kind":"open"}},
 {"taskId":"t2","title":"Late","state":{"kind":"missed"}},
 {"taskId":"t3","title":"Done","state":{"kind":"done"}},
 {"taskId":"t4","title":"Other day","state":{"kind":"doneElsewhere","completedOn":"2026-10-14"}},
 {"taskId":"t5","title":"Other event","state":{"kind":"doneElsewhere","eventName":"Standup"}},
 {"taskId":"t6","title":"Moved","state":{"kind":"moved","lastEventName":"Review"}},
 {"taskId":"t7","title":"Strange","state":{"kind":"future"}}],
 "counts":{"open":2,"total":7}}"""

private fun aTask(version: String = "v1") = WorkItem(ItemKind.TASK, "t1", version, "Task", Schedule(null, null, null))

private class RecordingItems(private val loaded: RepositoryResult<WorkItem>) : ItemRepository {
    val log = mutableListOf<String>()

    override suspend fun load(kind: ItemKind, id: String): RepositoryResult<WorkItem> {
        log += "load:$kind:$id"
        return loaded
    }

    override suspend fun update(item: WorkItem, change: ItemChange): RepositoryResult<WorkItem> {
        log += "update:${item.version}:$change"
        return RepositoryResult.Content(item)
    }

    override suspend fun delete(kind: ItemKind, id: String): RepositoryResult<Unit> = error("not used")
}

class HttpMeetingRepositoryTest {
    private fun recorder(items: String = "") = Recorder { request ->
        when (request.url.encodedPath) {
            "/api/events/e1/tasks" -> json(MEETING_TASKS)
            "/api/events/e1/transcript-action-items" -> json(items.ifEmpty { "[]" })
            "/api/databases" -> json("""{"databases":[{"id":"$MEETING_TASKS_DB","key":"tasks","name":"Tasks"}]}""")
            "/api/databases/$MEETING_TASKS_DB/items" -> json(CREATED, HttpStatusCode.Created)
            else -> json("{}", HttpStatusCode.NotFound)
        }
    }

    private fun repository(
        recorder: Recorder,
        items: ItemRepository = RecordingItems(RepositoryResult.Content(aTask())),
    ) =
        HttpMeetingRepository(recorder.api, ItemsApi(recorder.api), ItemWrites(recorder.api), items)

    @Test
    fun `the tasks of an event carry how each stands in it`() = runTest {
        val tasks = assertIs<RepositoryResult.Content<List<MeetingTask>>>(repository(recorder()).tasks("e1")).value

        assertEquals(
            listOf(
                MeetingTaskStatus.OPEN,
                MeetingTaskStatus.MISSED,
                MeetingTaskStatus.DONE,
                MeetingTaskStatus.DONE_ELSEWHERE,
                MeetingTaskStatus.DONE_ELSEWHERE,
                MeetingTaskStatus.MOVED,
                MeetingTaskStatus.OPEN,
            ),
            tasks.map { it.status },
        )
        assertEquals(listOf(null, null, null, "2026-10-14", "Standup", "Review", null), tasks.map { it.detail })
        assertEquals("Late", tasks[1].title)
    }

    @Test
    fun `the suggestions are the open action items of the event's transcripts`() = runTest {
        val recorder = recorder(
            """[{"transcriptId":"tr1","actionItemId":0,"text":"Send","ownerSpeaker":"S1","ownerLabel":"David",
                "due":"2026-10-23","startsAt":12.0,"state":"open"},
               {"transcriptId":"tr1","actionItemId":2,"text":"Wire","ownerSpeaker":null,"ownerLabel":null,
                "due":null,"startsAt":null,"state":"open"}]""",
        )

        val found = assertIs<RepositoryResult.Content<List<MeetingSuggestion>>>(
            repository(recorder).suggestions("e1"),
        ).value

        assertEquals(
            listOf(
                MeetingSuggestion("tr1", 0, "Send", "David", "2026-10-23"),
                MeetingSuggestion("tr1", 2, "Wire", null, null),
            ),
            found,
        )
        assertEquals("/api/events/e1/transcript-action-items", recorder.requests.single().url.encodedPath)
    }

    @Test
    fun `an event that is gone is not found and an answer that is not a list is invalid`() = runTest {
        val gone = repository(Recorder { json("{}", HttpStatusCode.NotFound) })
        val broken = repository(Recorder { json("""{"tasks":"x"}""") })

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.tasks("e1"))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.suggestions("e1"))
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), broken.tasks("e1"))
    }

    @Test
    fun `a new task is made in the tasks database and hosted by the event`() = runTest {
        val recorder = recorder()

        val result = repository(recorder).addTask("e1", "Book room")

        assertEquals(RepositoryResult.Content(Unit), result)
        val create = recorder.requests.last()
        assertEquals(HttpMethod.Post, create.method)
        assertEquals("/api/databases/$MEETING_TASKS_DB/items", create.url.encodedPath)
        val body = recorder.bodyJson(recorder.requests.lastIndex)
        assertEquals("Book room", body["properties"]?.jsonObject?.get("name")?.jsonPrimitive?.content)
        assertEquals("notDone", body["properties"]?.jsonObject?.get("status")?.jsonPrimitive?.content)
        val relation = body["relations"]?.jsonArray?.single()?.jsonObject
        assertEquals("hostEvents", relation?.get("propertyKey")?.jsonPrimitive?.content)
        assertEquals(JsonArray(listOf(JsonPrimitive("e1"))), relation?.get("targetItemIds"))
    }

    @Test
    fun `a task cannot be made when the server has no tasks database`() = runTest {
        val noTasks = Recorder { request ->
            if (request.url.encodedPath == "/api/databases") json("""{"databases":[]}""") else json("{}")
        }

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), repository(noTasks).addTask("e1", "x"))
        assertEquals(1, noTasks.requests.size)
    }

    @Test
    fun `finishing a task loads it and writes the change that names its version`() = runTest {
        val items = RecordingItems(RepositoryResult.Content(aTask("v7")))

        assertEquals(RepositoryResult.Content(Unit), repository(recorder(), items).setDone("t1", done = true))
        assertEquals(RepositoryResult.Content(Unit), repository(recorder(), items).setDone("t1", done = false))

        assertEquals(
            listOf(
                "load:TASK:t1",
                "update:v7:${ItemChange.Done(true)}",
                "load:TASK:t1",
                "update:v7:${ItemChange.Done(false)}",
            ),
            items.log,
        )
    }

    @Test
    fun `a task that cannot be loaded is not written`() = runTest {
        val items = RecordingItems(RepositoryResult.Failure(FailureKind.NOT_FOUND))

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), repository(recorder(), items).setDone("t1", true))
        assertEquals(listOf("load:TASK:t1"), items.log)
    }
}
