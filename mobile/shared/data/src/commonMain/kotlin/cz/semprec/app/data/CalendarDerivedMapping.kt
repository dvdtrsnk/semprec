package cz.semprec.app.data

import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.SleepNightEntry
import cz.semprec.app.domain.TraceOutcome

internal fun TimelineEntryDto.toSleep(): CalendarEntry? {
    val evening = parseDay(night)
    val bed = parseTime(bedTime)
    val wake = parseTime(wakeTime)
    if (evening == null || bed == null || wake == null) return null
    return CalendarEntry(
        id = id,
        kind = CalendarEntryKind.SLEEP,
        title = "",
        calendarId = null,
        date = evening,
        endDate = null,
        timeFrom = null,
        timeTo = null,
        effectiveTo = null,
        allDay = false,
        status = null,
        place = null,
        readOnly = false,
        version = null,
        sleep = SleepNightEntry(evening, bed, wake, alarm ?: false, changed ?: false, prepReminderAt),
    )
}

internal fun TimelineEntryDto.toTrace(taskTitles: Map<String, String>): CalendarEntry? {
    val traceDay = parseDay(day)
    val result = outcome?.toDomain()
    if (traceDay == null || result == null) return null
    val from = parseTime(sinceTime?.from)
    return CalendarEntry(
        id = id,
        kind = CalendarEntryKind.TRACE,
        title = taskTitles[taskId].orEmpty(),
        calendarId = null,
        date = traceDay,
        endDate = null,
        timeFrom = from,
        timeTo = from?.let { parseTime(sinceTime?.to) },
        effectiveTo = from?.let { parseTime(sinceTime?.to) },
        allDay = from == null,
        status = null,
        place = null,
        readOnly = true,
        version = null,
        trace = result.first,
        traceNote = result.second,
        sourceTaskId = taskId,
    )
}

private fun TraceOutcomeDto.toDomain(): Pair<TraceOutcome, String?>? = when (kind) {
    "carried" -> TraceOutcome.CARRIED to null
    "doneOn" -> TraceOutcome.DONE to date
    "movedToEvent" -> TraceOutcome.MOVED_TO_EVENT to title
    "missed" -> TraceOutcome.MISSED to null
    else -> null
}
