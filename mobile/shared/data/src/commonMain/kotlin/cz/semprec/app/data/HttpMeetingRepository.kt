package cz.semprec.app.data

import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.MeetingTaskStatus
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.MeetingRepository
import cz.semprec.app.domain.MeetingSuggestion
import cz.semprec.app.domain.MeetingTask
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `GET /api/events/:id/tasks`. */
@Serializable
internal data class MeetingTasksDto(val tasks: List<MeetingTaskDto> = emptyList())

@Serializable
internal data class MeetingTaskDto(val taskId: String, val title: String = "", val state: MeetingTaskStateDto)

/** A task's standing in the event: the [kind] and, for the two kinds that finished elsewhere, where to. */
@Serializable
internal data class MeetingTaskStateDto(
    val kind: String,
    val completedOn: String? = null,
    val eventName: String? = null,
    val lastEventName: String? = null,
)

/** One element of `GET /api/events/:id/transcript-action-items`. */
@Serializable
internal data class MeetingSuggestionDto(
    val transcriptId: String,
    val actionItemId: Int,
    val text: String = "",
    val ownerLabel: String? = null,
    val due: String? = null,
)

/**
 * The tasks of an event over the event routes of the server. A task is made in the tasks database with the event as
 * its host (`Tasks.hostEvents`), and finished through the same item write the Podrobnosti sheet uses.
 */
internal class HttpMeetingRepository(
    private val api: AuthenticatedApi,
    private val items: ItemsApi,
    private val writes: ItemWrites,
    private val details: ItemRepository,
) : MeetingRepository {

    override suspend fun tasks(eventId: String): RepositoryResult<List<MeetingTask>> =
        api.send(HttpMethod.Get, "/api/events/$eventId/tasks").decode<MeetingTasksDto>()
            .map { found -> found.tasks.map { it.toTask() } }

    override suspend fun suggestions(eventId: String): RepositoryResult<List<MeetingSuggestion>> =
        api.send(HttpMethod.Get, "/api/events/$eventId/transcript-action-items")
            .decode<List<MeetingSuggestionDto>>()
            .map { found ->
                found.map { MeetingSuggestion(it.transcriptId, it.actionItemId, it.text, it.ownerLabel, it.due) }
            }

    override suspend fun addTask(eventId: String, title: String): RepositoryResult<Unit> =
        items.databaseId(WorkKeys.TASKS).then { database ->
            val properties = buildJsonObject {
                put(WorkKeys.NAME, title)
                put(WorkKeys.STATUS, "notDone")
            }
            writes.create(database, properties, mapOf(WorkKeys.HOST_EVENTS to listOf(eventId)))
        }.map { }

    override suspend fun setDone(taskId: String, done: Boolean): RepositoryResult<Unit> =
        details.load(ItemKind.TASK, taskId).then { task -> details.update(task, ItemChange.Done(done)) }.map { }
}

private fun MeetingTaskDto.toTask(): MeetingTask = when (state.kind) {
    "missed" -> MeetingTask(taskId, title, MeetingTaskStatus.MISSED, null)
    "done" -> MeetingTask(taskId, title, MeetingTaskStatus.DONE, null)
    "doneElsewhere" -> MeetingTask(
        taskId,
        title,
        MeetingTaskStatus.DONE_ELSEWHERE,
        state.completedOn ?: state.eventName,
    )
    "moved" -> MeetingTask(taskId, title, MeetingTaskStatus.MOVED, state.lastEventName)
    else -> MeetingTask(taskId, title, MeetingTaskStatus.OPEN, null)
}
