package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarRepository
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.CalendarTimeline
import cz.semprec.app.domain.CalendarWindow
import cz.semprec.app.domain.NewCalendarItem
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The calendar over the backend: the timeline (`GET /api/calendar/timeline`), the calendars and the count of new
 * invitations beside it, and the writes of an event or a task through the item routes. A series occurrence that is
 * not stored yet is stored first (`POST /api/events|tasks/series/:id/occurrences/:date`), and every write is made
 * against the version the timeline carried. Each successful write raises [changes].
 */
class HttpCalendarRepository(
    private val api: AuthenticatedApi,
    private val changes: CalendarChanges,
) : CalendarRepository {
    private val databases = CalendarDatabases(api)

    override suspend fun window(from: CalendarDay, to: CalendarDay): RepositoryResult<CalendarWindow> {
        val query = listOf("from" to from.toString(), "to" to to.toString())
        val timeline = api.send(HttpMethod.Get, "/api/calendar/timeline", query = query)
            .decode<TimelineResponse>().toTimeline()
        val calendars = databases.items(CalendarDatabaseKeys.CALENDARS)
        val badge = api.send(HttpMethod.Get, "/api/badge-counts").decode<BadgeCountsResponse>()
        return when {
            timeline is RepositoryResult.Failure -> timeline
            calendars is RepositoryResult.Failure -> calendars
            badge is RepositoryResult.Failure -> badge
            timeline is RepositoryResult.Content && calendars is RepositoryResult.Content &&
                badge is RepositoryResult.Content -> RepositoryResult.Content(
                CalendarWindow(
                    timeline.value,
                    calendars.value.mapNotNull { it.toCalendar() },
                    badge.value.pendingInvites,
                ),
            )
            else -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
    }

    override suspend fun reschedule(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<Unit> =
        patch(entry, schedule.toProperties(entry.kind))

    override suspend fun setTaskDone(entry: CalendarEntry, done: Boolean): RepositoryResult<Unit> {
        val status = if (done) CalendarEntry.STATUS_DONE else CalendarEntry.STATUS_OPEN
        return patch(entry, buildJsonObject { put("status", JsonPrimitive(status)) })
    }

    override suspend fun putTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit> {
        val storedTask = stored(task)
        val storedEvent = stored(event)
        return when {
            storedTask is RepositoryResult.Failure -> storedTask
            storedEvent is RepositoryResult.Failure -> storedEvent
            storedTask is RepositoryResult.Content && storedEvent is RepositoryResult.Content ->
                api.send(HttpMethod.Put, "/api/tasks/${storedTask.value.id}/host-events/${storedEvent.value.id}")
                    .ignoreBody().alsoChanged()
            else -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
    }

    override suspend fun duplicate(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<String> =
        when (val item = stored(entry)) {
            is RepositoryResult.Failure -> item
            is RepositoryResult.Content -> {
                val body = DuplicateRequest(
                    date = schedule.date.toString(),
                    timeFrom = schedule.timeFrom?.toString(),
                    timeTo = schedule.timeTo?.toString(),
                    endDate = schedule.endDate?.toString().takeIf { entry.kind == CalendarEntryKind.EVENT },
                )
                val path = "/api/calendar/items/${item.value.id}/duplicate"
                when (
                    val copy = api.send(HttpMethod.Post, path, body = ApiJson.encodeToString(body))
                        .decode<CalendarStoredItem>()
                ) {
                    is RepositoryResult.Failure -> copy
                    is RepositoryResult.Content -> RepositoryResult.Content(copy.value.id).alsoChanged()
                }
            }
        }

    override suspend fun delete(entry: CalendarEntry): RepositoryResult<Unit> =
        when (val item = stored(entry)) {
            is RepositoryResult.Failure -> item
            is RepositoryResult.Content ->
                api.send(HttpMethod.Delete, "/api/items/${item.value.id}").ignoreBody().alsoChanged()
        }

    override suspend fun create(draft: NewCalendarItem): RepositoryResult<String> {
        val key = if (draft.kind == CalendarEntryKind.EVENT) CalendarDatabaseKeys.EVENTS else CalendarDatabaseKeys.TASKS
        return when (val database = databases.id(key)) {
            is RepositoryResult.Failure -> database
            is RepositoryResult.Content -> createIn(database.value, draft)
        }
    }

    private suspend fun createIn(databaseId: String, draft: NewCalendarItem): RepositoryResult<String> {
        val body = ApiJson.encodeToString(CalendarCreateRequest(draft.toProperties()))
        val created = api.send(HttpMethod.Post, "/api/databases/$databaseId/items", body = body)
            .decode<CalendarStoredItem>()
        return when (created) {
            is RepositoryResult.Failure -> created
            is RepositoryResult.Content -> {
                val calendar = draft.calendarId.takeIf { draft.kind == CalendarEntryKind.EVENT }
                val linked = if (calendar == null) {
                    RepositoryResult.Content(Unit)
                } else {
                    api.send(HttpMethod.Put, "/api/items/${created.value.id}/relations/calendar/$calendar").ignoreBody()
                }
                when (linked) {
                    is RepositoryResult.Failure -> linked
                    is RepositoryResult.Content -> RepositoryResult.Content(created.value.id).alsoChanged()
                }
            }
        }
    }

    /**
     * Patches the stored item of [entry] with [properties], against the version the timeline gave; an entry that
     * came without a version (a task listed inside an event) is patched without the check.
     */
    private suspend fun patch(entry: CalendarEntry, properties: JsonObject): RepositoryResult<Unit> =
        when (val item = stored(entry)) {
            is RepositoryResult.Failure -> item
            is RepositoryResult.Content -> {
                val version = item.value.updatedAt.takeIf { it.isNotEmpty() }
                val body = ApiJson.encodeToString(CalendarPatchRequest(properties, version))
                api.send(HttpMethod.Patch, "/api/items/${item.value.id}", body = body).ignoreBody().alsoChanged()
            }
        }

    /** The stored item behind [entry]: itself, or the occurrence of a series stored just now. */
    private suspend fun stored(entry: CalendarEntry): RepositoryResult<StoredRef> {
        val series = entry.seriesId
        val occurrence = entry.occurrenceDate
        if (!entry.isVirtualOccurrence || series == null || occurrence == null) {
            return RepositoryResult.Content(StoredRef(entry.id, entry.updatedAt.orEmpty()))
        }
        val family = if (entry.kind == CalendarEntryKind.EVENT) "events" else "tasks"
        val response = api.send(HttpMethod.Post, "/api/$family/series/$series/occurrences/$occurrence")
        return when (val item = response.decode<CalendarStoredItem>()) {
            is RepositoryResult.Failure -> item
            is RepositoryResult.Content -> RepositoryResult.Content(StoredRef(item.value.id, item.value.updatedAt))
        }
    }

    private fun <T> RepositoryResult<T>.alsoChanged(): RepositoryResult<T> {
        if (this is RepositoryResult.Content) changes.changed()
        return this
    }

    private data class StoredRef(val id: String, val updatedAt: String)
}

private fun RepositoryResult<TimelineResponse>.toTimeline(): RepositoryResult<CalendarTimeline> = when (this) {
    is RepositoryResult.Failure -> this
    is RepositoryResult.Content -> value.toDomain()
}

private fun NewCalendarItem.toProperties(): JsonObject = buildJsonObject {
    put("name", JsonPrimitive(title))
    put("date", JsonPrimitive(schedule.date.toString()))
    schedule.timeFrom?.let { put("timeFrom", JsonPrimitive(it.toString())) }
    schedule.timeTo?.let { put("timeTo", JsonPrimitive(it.toString())) }
    if (kind == CalendarEntryKind.EVENT) {
        schedule.endDate?.let { put("endDate", JsonPrimitive(it.toString())) }
        place?.let { put("place", JsonPrimitive(it)) }
    }
}
