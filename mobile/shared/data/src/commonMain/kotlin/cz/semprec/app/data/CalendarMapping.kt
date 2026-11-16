package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarTimeline
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.EventTaskEntry
import cz.semprec.app.domain.EventTaskState
import cz.semprec.app.domain.RepositoryResult
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject

private const val MINUTES_IN_HOUR = 60
private const val DAYS_IN_HEADER = 3
private const val KIND_SLEEP = "sleep"
private const val KIND_TRACE = "trace"

/** The timeline as the domain reads it; a value the app cannot read makes the whole answer unreadable. */
internal fun TimelineResponse.toDomain(): RepositoryResult<CalendarTimeline> {
    val today = parseDay(today)
    val first = parseDay(from)
    val last = parseDay(to)
    val time = parseTime(now.time)
    val days = listOfNotNull(today, first, last)
    if (days.size != DAYS_IN_HEADER || time == null) return RepositoryResult.Failure(FailureKind.INVALID_DATA)
    val dtos = items.mapNotNull { it.toEntryDto() }
    val titles = dtos.filter { it.kind == "task" }.associate { it.id to it.title.orEmpty() }
    val entries = dtos.mapNotNull { it.toEntry(titles) }
    val minutes = time.hour * MINUTES_IN_HOUR + time.minute
    return RepositoryResult.Content(CalendarTimeline(timezone, days[0], minutes, days[1], days[2], entries))
}

internal fun JsonObject.toEntryDto(): TimelineEntryDto? = try {
    ApiJson.decodeFromJsonElement(TimelineEntryDto.serializer(), this)
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

internal fun parseDay(text: String?): CalendarDay? = text?.let { CalendarDay.parse(it) }

internal fun parseTime(text: String?): ClockTime? = text?.let { ClockTime.parse(it) }

/** An entry of a kind the app shows, or `null` for one it does not know or cannot read. */
internal fun TimelineEntryDto.toEntry(taskTitles: Map<String, String>): CalendarEntry? = when (kind) {
    "event" -> toStored(CalendarEntryKind.EVENT)
    "task" -> toStored(CalendarEntryKind.TASK)
    "birthday" -> toDerived(CalendarEntryKind.BIRTHDAY)
    "holiday" -> toDerived(CalendarEntryKind.HOLIDAY)
    KIND_SLEEP -> toSleep()
    KIND_TRACE -> toTrace(taskTitles)
    else -> null
}

private fun TimelineEntryDto.toStored(entryKind: CalendarEntryKind): CalendarEntry? {
    val first = parseDay(date) ?: return null
    return CalendarEntry(
        id = id,
        kind = entryKind,
        title = title.orEmpty(),
        calendarId = calendarId,
        date = first,
        endDate = parseDay(endDate),
        timeFrom = parseTime(timeFrom),
        timeTo = parseTime(timeTo),
        effectiveTo = parseTime(effectiveTo),
        allDay = allDay ?: (timeFrom == null),
        status = status,
        place = place,
        readOnly = readOnly ?: false,
        updatedAt = updatedAt,
        seriesId = seriesId,
        occurrenceDate = parseDay(occurrenceDate),
        tentative = attendance == "tentative",
        tasks = tasks.orEmpty().map { it.toDomain() },
        hostEventTitle = hostEvent?.title,
        carriedFrom = parseDay(carriedFrom),
    )
}

private fun TimelineEntryDto.toDerived(entryKind: CalendarEntryKind): CalendarEntry? {
    val first = parseDay(date) ?: return null
    return CalendarEntry(
        id = id,
        kind = entryKind,
        title = title.orEmpty(),
        calendarId = calendarId,
        date = first,
        endDate = null,
        timeFrom = null,
        timeTo = null,
        effectiveTo = null,
        allDay = true,
        status = null,
        place = null,
        readOnly = true,
        updatedAt = null,
    )
}

private fun EventTaskDto.toDomain(): EventTaskEntry {
    val note = state.completedOn ?: state.eventName ?: state.lastEventName
    val mapped = when (state.kind) {
        "done" -> EventTaskState.DONE
        "missed" -> EventTaskState.MISSED
        "doneElsewhere" -> EventTaskState.DONE_ELSEWHERE
        "moved" -> EventTaskState.MOVED
        else -> EventTaskState.OPEN
    }
    return EventTaskEntry(taskId, title, mapped, note)
}
