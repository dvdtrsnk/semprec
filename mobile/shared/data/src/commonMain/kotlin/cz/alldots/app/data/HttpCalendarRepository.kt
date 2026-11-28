package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CalendarChanges
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.CalendarRepeat
import cz.alldots.app.domain.CalendarRepository
import cz.alldots.app.domain.CalendarSchedule
import cz.alldots.app.domain.CalendarTimeline
import cz.alldots.app.domain.CalendarWindow
import cz.alldots.app.domain.NewCalendarItem
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The calendar over the backend: the timeline (`GET /api/calendar/timeline`), the calendars and the count of new
 * invitations beside it, and the writes of an event or a task through the item routes. A series occurrence that is
 * not stored yet is stored first (`POST /api/events|tasks/series/:id/occurrences/:date`), and every write is made
 * against the version the timeline carried. A new event is created together with its calendar, and every create
 * sends its submission key as `Idempotency-Key`. Each successful write raises [changes].
 */
class HttpCalendarRepository(
    private val api: AuthenticatedApi,
    private val changes: CalendarChanges,
) : CalendarRepository {
    private val databases = CalendarDatabases(api)

    /**
     * The timeline, the calendars and the badge are read together; the first that fails, in this order, is the
     * answer.
     */
    override suspend fun window(from: CalendarDay, to: CalendarDay): RepositoryResult<CalendarWindow> = coroutineScope {
        val query = listOf("from" to from.toString(), "to" to to.toString())
        val timelineRead = async {
            api.send(HttpMethod.Get, "/api/calendar/timeline", query = query).decode<TimelineResponse>().toTimeline()
        }
        val calendarsRead = async { databases.items(CalendarDatabaseKeys.CALENDARS) }
        val badgeRead = async { api.send(HttpMethod.Get, "/api/badge-counts").decode<BadgeCountsResponse>() }
        val timeline = timelineRead.await()
        val calendars = calendarsRead.await()
        val badge = badgeRead.await()
        when {
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

    override suspend fun completeTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit> {
        val storedTask = stored(task)
        val storedEvent = stored(event)
        return when {
            storedTask is RepositoryResult.Failure -> storedTask
            storedEvent is RepositoryResult.Failure -> storedEvent
            storedTask is RepositoryResult.Content && storedEvent is RepositoryResult.Content ->
                api.send(
                    HttpMethod.Put,
                    "/api/tasks/${storedTask.value.id}/completed-in-event/${storedEvent.value.id}",
                ).ignoreBody().alsoChanged()
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

    /**
     * Creates the item in one request. The chosen calendar of an event is an initial relation, because the server
     * links an event created without one to the default calendar, and an event has one calendar only.
     */
    private suspend fun createIn(databaseId: String, draft: NewCalendarItem): RepositoryResult<String> {
        val calendar = draft.calendarId.takeIf { draft.kind == CalendarEntryKind.EVENT }
        val relations = calendar?.let { listOf(CalendarCreateRelation(CALENDAR_RELATION, listOf(it))) }
        val body = ApiJson.encodeToString(CalendarCreateRequest(draft.toProperties(), relations))
        val created = api.send(
            HttpMethod.Post,
            "/api/databases/$databaseId/items",
            body = body,
            extraHeaders = listOf(IDEMPOTENCY_KEY_HEADER to draft.submissionKey),
        ).decode<CalendarStoredItem>()
        return when (created) {
            is RepositoryResult.Failure -> created
            is RepositoryResult.Content -> when (val repeated = repeatTask(created.value.id, draft)) {
                is RepositoryResult.Failure -> repeated
                is RepositoryResult.Content -> RepositoryResult.Content(created.value.id).alsoChanged()
            }
        }
    }

    /**
     * Sets the repetition of a new task (`PUT /api/tasks/:id/recurrence`), which lives beside the task rather than in
     * its properties; an event carries its rule in its properties instead.
     */
    private suspend fun repeatTask(taskId: String, draft: NewCalendarItem): RepositoryResult<Unit> {
        val preset = draft.repeat.taskPreset
        if (draft.kind != CalendarEntryKind.TASK || preset == null) return RepositoryResult.Content(Unit)
        val body = ApiJson.encodeToString(buildJsonObject { put("preset", JsonPrimitive(preset)) })
        return api.send(HttpMethod.Put, "/api/tasks/$taskId/recurrence", body = body).ignoreBody()
    }

    /**
     * Patches the stored item of [entry] with [properties], against the version the timeline gave; an entry that
     * came without a version (a task listed inside an event) is patched without the check.
     */
    private suspend fun patch(entry: CalendarEntry, properties: JsonObject): RepositoryResult<Unit> =
        when (val item = stored(entry)) {
            is RepositoryResult.Failure -> item
            is RepositoryResult.Content -> {
                val version = item.value.version.takeIf { it.isNotEmpty() }
                val body = ApiJson.encodeToString(CalendarPatchRequest(properties, version))
                api.send(HttpMethod.Patch, "/api/items/${item.value.id}", body = body).ignoreBody().alsoChanged()
            }
        }

    /** The stored item behind [entry]: itself, or the occurrence of a series stored just now. */
    private suspend fun stored(entry: CalendarEntry): RepositoryResult<StoredRef> {
        val series = entry.seriesId
        val occurrence = entry.occurrenceDate
        if (!entry.isVirtualOccurrence || series == null || occurrence == null) {
            return RepositoryResult.Content(StoredRef(entry.id, entry.version.orEmpty()))
        }
        val family = if (entry.kind == CalendarEntryKind.EVENT) "events" else "tasks"
        val response = api.send(HttpMethod.Post, "/api/$family/series/$series/occurrences/$occurrence")
        return when (val item = response.decode<CalendarStoredItem>()) {
            is RepositoryResult.Failure -> item
            is RepositoryResult.Content -> RepositoryResult.Content(StoredRef(item.value.id, item.value.version))
        }
    }

    private fun <T> RepositoryResult<T>.alsoChanged(): RepositoryResult<T> {
        if (this is RepositoryResult.Content) changes.changed()
        return this
    }

    private data class StoredRef(val id: String, val version: String)
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
    notes?.let { put("description", JsonPrimitive(it)) }
    if (kind == CalendarEntryKind.EVENT) {
        schedule.endDate?.let { put("endDate", JsonPrimitive(it.toString())) }
        place?.let { put("place", JsonPrimitive(it)) }
        url?.let { put("url", JsonPrimitive(it)) }
        alertMinutes?.let { put("alertMinutes", JsonPrimitive(it)) }
        travelMinutes?.let { put("travelMinutes", JsonPrimitive(it)) }
        eventRecurrence(repeat, schedule.date)?.let { put("recurrence", it) }
    } else if (flagged) {
        put("flagged", JsonPrimitive(true))
    }
}

private val ISO_WEEKDAYS = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")

/**
 * The fixed rule an event repeats by, from its first [day]: every weekday, Monday to Friday, its own weekday or its
 * day of the month. An event never repeats yearly; the rules leave that out.
 */
private fun eventRecurrence(repeat: CalendarRepeat, day: CalendarDay): JsonObject? {
    fun weekdays(days: List<String>) = buildJsonObject {
        put("kind", JsonPrimitive("weekdays"))
        put("days", JsonArray(days.map(::JsonPrimitive)))
    }
    return when (repeat) {
        CalendarRepeat.NEVER, CalendarRepeat.YEARLY -> null
        CalendarRepeat.DAILY -> weekdays(ISO_WEEKDAYS)
        CalendarRepeat.WEEKDAYS -> weekdays(ISO_WEEKDAYS.take(WORKING_DAYS))
        CalendarRepeat.WEEKLY -> weekdays(listOf(ISO_WEEKDAYS[day.isoDayOfWeek - 1]))
        CalendarRepeat.MONTHLY -> buildJsonObject {
            put("kind", JsonPrimitive("monthDates"))
            put("dates", JsonArray(listOf(JsonPrimitive(day.day))))
        }
    }
}

private const val WORKING_DAYS = 5

/** The relation of an event to its one calendar. */
private const val CALENDAR_RELATION = "calendar"

private const val IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"

/** The server's preset for a repeating task, `null` for one that does not repeat. */
private val CalendarRepeat.taskPreset: String?
    get() = when (this) {
        CalendarRepeat.NEVER -> null
        CalendarRepeat.DAILY -> "daily"
        CalendarRepeat.WEEKDAYS -> "weekdays"
        CalendarRepeat.WEEKLY -> "weekly"
        CalendarRepeat.MONTHLY -> "monthly"
        CalendarRepeat.YEARLY -> "yearly"
    }
