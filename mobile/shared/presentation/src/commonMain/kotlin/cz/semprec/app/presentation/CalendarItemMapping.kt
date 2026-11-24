package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.EventTaskEntry
import cz.semprec.app.domain.EventTaskState
import cz.semprec.app.domain.SleepNightEntry
import cz.semprec.app.domain.TimelineLane
import cz.semprec.app.domain.TraceOutcome
import cz.semprec.app.domain.isEditable

internal fun CalendarEntry.toItem(day: CalendarDay, color: String, lane: TimelineLane?): CalendarItem {
    val range = timedRange(day)
    val timedHere = range != null
    return CalendarItem(
        id = id,
        kind = kind.toItemKind(),
        title = title,
        color = color,
        date = date.toString(),
        endDate = endDate?.toString(),
        allDay = !timedHere,
        startMinutes = range?.first,
        endMinutes = range?.last,
        hasEnd = timeTo != null && !continuesAfter(day),
        done = isDone,
        missed = isMissed,
        place = place,
        tentative = tentative,
        editable = isEditable,
        column = lane?.column ?: 0,
        columns = lane?.columns ?: 1,
        depth = lane?.depth ?: 0,
        tasks = tasks.map { it.toState() },
        hostEventTitle = hostEventTitle,
        carriedFrom = carriedFrom?.toString(),
        trace = trace?.toState(),
        traceNote = traceNote,
    )
}

private fun TraceOutcome.toState(): CalendarTraceOutcome = when (this) {
    TraceOutcome.CARRIED -> CalendarTraceOutcome.CARRIED
    TraceOutcome.DONE -> CalendarTraceOutcome.DONE
    TraceOutcome.MOVED_TO_EVENT -> CalendarTraceOutcome.MOVED_TO_EVENT
    TraceOutcome.MISSED -> CalendarTraceOutcome.MISSED
}

private fun EventTaskEntry.toState(): CalendarEventTask = CalendarEventTask(id, title, state.toState(), note)

private fun EventTaskState.toState(): CalendarTaskInEvent = when (this) {
    EventTaskState.OPEN -> CalendarTaskInEvent.OPEN
    EventTaskState.MISSED -> CalendarTaskInEvent.MISSED
    EventTaskState.DONE -> CalendarTaskInEvent.DONE
    EventTaskState.DONE_ELSEWHERE -> CalendarTaskInEvent.DONE_ELSEWHERE
    EventTaskState.MOVED -> CalendarTaskInEvent.MOVED
}

/** The time of day of an instant written with the zone's own offset (`2026-10-15T22:30:00+02:00`). */
private fun String.timeOfDay(): Int? =
    substringAfter('T', "").take(CLOCK_TEXT_LENGTH).let { ClockTime.parse(it) }?.minutes

private const val CLOCK_TEXT_LENGTH = 5

internal fun SleepNightEntry.toState(): CalendarSleep =
    CalendarSleep(night.toString(), bedTime.minutes, wakeTime.minutes, alarm, changed, prepReminderAt?.timeOfDay())
