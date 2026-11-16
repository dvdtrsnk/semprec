package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.LinkedValue
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.WorkItem
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One task or event of the generic item API, with the relations the Podrobnosti sheet shows. */
internal class HttpItemRepository(
    private val items: ItemsApi,
    private val writes: ItemWrites,
) : ItemRepository {
    override suspend fun load(kind: ItemKind, id: String): RepositoryResult<WorkItem> =
        items.get(id, WorkKeys.detailRelations(kind), links = true).map { it.toWorkItem(kind) }

    override suspend fun update(item: WorkItem, change: ItemChange): RepositoryResult<WorkItem> =
        write(item, change).then { load(item.kind, item.id) }

    override suspend fun delete(kind: ItemKind, id: String): RepositoryResult<Unit> = writes.delete(id)

    private suspend fun write(item: WorkItem, change: ItemChange): RepositoryResult<Unit> = when (change) {
        is ItemChange.Title,
        is ItemChange.Done,
        is ItemChange.Description,
        is ItemChange.Place,
        is ItemChange.Flagged,
        is ItemChange.Reschedule,
        -> writes.patch(item.id, change.properties(item.kind), item.version).map { }
        is ItemChange.Repeat -> setRepeat(item, change.repeat)
        is ItemChange.Project,
        is ItemChange.AddPerson,
        is ItemChange.RemovePerson,
        is ItemChange.RemoveFile,
        is ItemChange.Unlink,
        is ItemChange.Relink,
        -> writeRelation(item, change)
    }

    private suspend fun writeRelation(item: WorkItem, change: ItemChange): RepositoryResult<Unit> = when (change) {
        is ItemChange.Project -> writes.setRelation(item.id, WorkKeys.PROJECT, change.projectId)
        is ItemChange.AddPerson -> writes.addRelation(item.id, WorkKeys.PEOPLE, change.personId)
        is ItemChange.RemovePerson -> writes.removeRelation(item.id, WorkKeys.PEOPLE, change.personId)
        is ItemChange.RemoveFile -> writes.removeRelation(item.id, WorkKeys.FILES, change.fileId)
        is ItemChange.Unlink -> writes.changeValueLink(item.id, change.value.key(), relink = false)
        is ItemChange.Relink -> writes.changeValueLink(item.id, change.value.key(), relink = true)
        else -> RepositoryResult.Failure(FailureKind.REJECTED)
    }

    private suspend fun setRepeat(item: WorkItem, repeat: TaskRepeat): RepositoryResult<Unit> {
        val path = "/api/tasks/${item.id}/recurrence"
        val preset = repeat.presetName()
        return when {
            repeat == TaskRepeat.NONE -> items.send(HttpMethod.Delete, path).ignoreBody()
            preset == null -> RepositoryResult.Failure(FailureKind.REJECTED)
            else -> items.send(HttpMethod.Put, path, body = buildJsonObject { put("preset", preset) }).ignoreBody()
        }
    }
}

private fun LinkedValue.key(): String = if (this == LinkedValue.PROJECT) WorkKeys.PROJECT else WorkKeys.PEOPLE

/** The properties a change of an item of [kind] writes; an end day only exists on an event. */
private fun ItemChange.properties(kind: ItemKind): JsonObject = JsonObject(
    when (this) {
        is ItemChange.Title -> mapOf(WorkKeys.NAME to JsonPrimitive(text))
        is ItemChange.Done -> mapOf(WorkKeys.STATUS to JsonPrimitive(if (done) "done" else "notDone"))
        is ItemChange.Description -> mapOf(WorkKeys.DESCRIPTION to JsonPrimitive(text))
        is ItemChange.Place -> mapOf(WorkKeys.PLACE to JsonPrimitive(text))
        is ItemChange.Flagged -> mapOf(WorkKeys.FLAGGED to JsonPrimitive(flagged))
        is ItemChange.Reschedule -> schedule.properties(kind)
        else -> emptyMap()
    },
)

private fun Schedule.properties(kind: ItemKind): Map<String, JsonElement> = buildMap {
    put(WorkKeys.DATE, date.toJson())
    put(WorkKeys.TIME_FROM, timeFrom.toJson())
    put(WorkKeys.TIME_TO, timeTo.toJson())
    if (kind == ItemKind.EVENT) put(WorkKeys.END_DATE, endDate.toJson())
}
