package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.EventTaskEntry
import cz.semprec.app.domain.EventTaskState
import cz.semprec.app.domain.SleepNightEntry
import cz.semprec.app.domain.SleepRules
import cz.semprec.app.domain.TraceOutcome
import cz.semprec.app.domain.isEditable

internal fun CalendarEntry.toItem(day: CalendarDay, color: String, column: Int, columns: Int): CalendarItem {
    val timedHere = isTimedOn(day)
    val range = if (timedHere) minutes() else null
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
        hasEnd = timeTo != null,
        done = isDone,
        missed = isMissed,
        place = place,
        tentative = tentative,
        editable = isEditable,
        column = column,
        columns = columns,
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

/**
 * The part of this night on [day], the evening [night] or the day after it; `null` when nothing of it falls there.
 * A night that starts the evening before (bedtime from noon on) runs from bedtime to midnight on the evening and from
 * midnight to wake time the next day; an earlier bedtime puts the whole night on the morning of the wake day.
 */
internal fun SleepNightEntry.toState(day: CalendarDay): CalendarSleep? {
    val bed = bedTime.minutes
    val wake = wakeTime.minutes
    val onEvening = day == night
    val startsTheEveningBefore = bed >= SleepRules.EVENING_FROM_MINUTES
    val (from, to) = when {
        onEvening && startsTheEveningBefore -> bed to ClockTime.DAY_MINUTES
        onEvening -> 0 to 0
        startsTheEveningBefore -> 0 to wake
        else -> bed to maxOf(bed, wake)
    }
    val prep = prepReminderAt?.takeIf { it.substringBefore('T') == day.toString() }?.timeOfDay()
    return if (from == to && prep == null) {
        null
    } else {
        CalendarSleep(night.toString(), bed, wake, alarm, changed, prep, from, to)
    }
}
