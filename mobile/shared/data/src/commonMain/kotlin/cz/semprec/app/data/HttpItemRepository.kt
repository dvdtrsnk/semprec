package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.LinkedValue
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.domain.CalendarDay
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
    /**
     * An occurrence of a series not stored yet (`series@YYYY-MM-DD`, as the calendar names it) reads as its series
     * moved to the occurrence's day, under the occurrence's id: it has no row of its own until it is changed.
     */
    override suspend fun load(kind: ItemKind, id: String): RepositoryResult<WorkItem> {
        val occurrence = SeriesOccurrence.parse(id)
            ?: return items.get(id, WorkKeys.detailRelations(kind), links = true).map { it.toWorkItem(kind) }
        return items.get(occurrence.seriesId, WorkKeys.detailRelations(kind), links = true)
            .map { occurrence.of(it.toWorkItem(kind)) }
    }

    /** A change to an occurrence not stored yet stores it first, and is made to the stored row. */
    override suspend fun update(item: WorkItem, change: ItemChange): RepositoryResult<WorkItem> =
        stored(item.kind, item.id, item.version).then { (id, version) ->
            write(item.copy(id = id, version = version), change).then { load(item.kind, id) }
        }

    override suspend fun delete(kind: ItemKind, id: String): RepositoryResult<Unit> =
        stored(kind, id, version = "").then { (storedId, _) -> writes.delete(storedId) }

    /** The id and version of the row behind [id]: itself, or the occurrence of a series stored just now. */
    private suspend fun stored(kind: ItemKind, id: String, version: String): RepositoryResult<Pair<String, String>> {
        val occurrence = SeriesOccurrence.parse(id) ?: return RepositoryResult.Content(id to version)
        val family = if (kind == ItemKind.EVENT) "events" else "tasks"
        val path = "/api/$family/series/${occurrence.seriesId}/occurrences/${occurrence.day}"
        return items.send(HttpMethod.Post, path).decode<CalendarStoredItem>().map { it.id to it.version }
    }

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

/** An occurrence of a series that is not a stored row yet, named `series@YYYY-MM-DD` as the calendar names it. */
private data class SeriesOccurrence(val seriesId: String, val day: CalendarDay) {

    /** [series] as this occurrence: under its id, on its day, a last day kept as far from the first. */
    fun of(series: WorkItem): WorkItem {
        val start = series.schedule.date?.let(CalendarDay::parse)
        val shift = start?.let { (day.epochDay - it.epochDay).toInt() } ?: 0
        val end = series.schedule.endDate?.let(CalendarDay::parse)?.plusDays(shift)
        return series.copy(
            id = "$seriesId@$day",
            schedule = series.schedule.copy(date = day.toString(), endDate = end?.toString()),
        )
    }

    companion object {
        fun parse(id: String): SeriesOccurrence? {
            val parts = id.split('@')
            if (parts.size != 2 || parts[0].isEmpty()) return null
            return CalendarDay.parse(parts[1])?.let { SeriesOccurrence(parts[0], it) }
        }
    }
}
