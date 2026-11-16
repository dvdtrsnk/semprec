package cz.semprec.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** `GET /api/schema`, reduced to what finds the calendar databases by their canonical key. */
@Serializable
internal data class CalendarSchemaResponse(val databases: List<CalendarSchemaDatabase>)

@Serializable
internal data class CalendarSchemaDatabase(val databaseId: String, val key: String? = null)

/** One stored item of the generic item API. */
@Serializable
internal data class CalendarStoredItem(
    val id: String,
    val properties: JsonObject = JsonObject(emptyMap()),
    val updatedAt: String,
)

@Serializable
internal data class CalendarItemList(val items: List<CalendarStoredItem>)

/** `GET /api/calendar/timeline`: the entries are decoded one by one so that an unknown kind is skipped. */
@Serializable
internal data class TimelineResponse(
    val timezone: String,
    val today: String,
    val now: TimelineNow,
    val from: String,
    val to: String,
    val items: List<JsonObject>,
)

@Serializable
internal data class TimelineNow(val date: String, val time: String)

/**
 * The fields of every kind of timeline entry. A stored event or task fills the schedule fields, a derived entry
 * the ones of its kind; the rest stays `null`.
 */
@Serializable
internal data class TimelineEntryDto(
    val kind: String,
    val id: String,
    val title: String? = null,
    val date: String? = null,
    val endDate: String? = null,
    val timeFrom: String? = null,
    val timeTo: String? = null,
    val effectiveTo: String? = null,
    val allDay: Boolean? = null,
    val calendarId: String? = null,
    val status: String? = null,
    val place: String? = null,
    val readOnly: Boolean? = null,
    val updatedAt: String? = null,
    val seriesId: String? = null,
    val occurrenceDate: String? = null,
    val attendance: String? = null,
    val tasks: List<EventTaskDto>? = null,
    val hostEvent: HostEventDto? = null,
    val carriedFrom: String? = null,
    val night: String? = null,
    val bedTime: String? = null,
    val wakeTime: String? = null,
    val alarm: Boolean? = null,
    val changed: Boolean? = null,
    val prepReminderAt: String? = null,
    val taskId: String? = null,
    val day: String? = null,
    val outcome: TraceOutcomeDto? = null,
    val sinceTime: SinceTimeDto? = null,
)

@Serializable
internal data class EventTaskDto(val taskId: String, val title: String, val state: EventTaskStateDto)

@Serializable
internal data class EventTaskStateDto(
    val kind: String,
    val completedOn: String? = null,
    val eventName: String? = null,
    val lastEventName: String? = null,
)

@Serializable
internal data class HostEventDto(val id: String, val title: String)

@Serializable
internal data class TraceOutcomeDto(
    val kind: String,
    val date: String? = null,
    val title: String? = null,
)

@Serializable
internal data class SinceTimeDto(val from: String? = null, val to: String? = null)

@Serializable
internal data class BadgeCountsResponse(val pendingInvites: Int = 0)

/** A body that patches the user properties of an item the caller has read, so the version is the one it read. */
@Serializable
internal data class CalendarPatchRequest(val properties: JsonObject, val ifVersion: String? = null)

@Serializable
internal data class CalendarCreateRequest(val properties: JsonObject)

@Serializable
internal data class CancellationImpactDto(
    val eventCount: Int = 0,
    val recipientCount: Int = 0,
    val cancellationCount: Int = 0,
)

@Serializable
internal data class InvitationRespondRequest(val response: String)

@Serializable
internal data class DuplicateRequest(
    val date: String,
    val timeFrom: String? = null,
    val timeTo: String? = null,
    val endDate: String? = null,
)
