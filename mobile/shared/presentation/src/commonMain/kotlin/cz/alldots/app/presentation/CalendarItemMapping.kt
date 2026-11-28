package cz.alldots.app.presentation

import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.ClockTime
import cz.alldots.app.domain.EventTaskEntry
import cz.alldots.app.domain.EventTaskState
import cz.alldots.app.domain.SleepNightEntry
import cz.alldots.app.domain.SleepRules
import cz.alldots.app.domain.TimelineLane
import cz.alldots.app.domain.TraceOutcome
import cz.alldots.app.domain.isEditable

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
        timeFrom = timeFrom?.minutes,
        timeTo = (timeTo ?: if (kind == CalendarEntryKind.EVENT) effectiveTo else null)?.minutes,
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
 * midnight to wake time the next day; an earlier bedtime puts the whole night on the morning of the wake day. The
 * part of a day the night does not reach is empty (`fromMinutes == toMinutes`), which the bedtime reminder alone can
 * still fall on.
 */
internal fun SleepNightEntry.toState(day: CalendarDay): CalendarSleep? {
    val bed = bedTime.minutes
    val wake = wakeTime.minutes
    val onEvening = day == night
    val startsTheEveningBefore = SleepRules.startsTheEveningBefore(bedTime)
    val (from, to) = when {
        onEvening && startsTheEveningBefore -> bed to ClockTime.DAY_MINUTES
        onEvening -> 0 to 0
        startsTheEveningBefore -> 0 to wake
        else -> bed to maxOf(bed, wake)
    }
    val prep = prepReminderAt?.takeIf { it.substringBefore('T') == day.toString() }?.timeOfDay()
    if (from == to && prep == null) return null
    val duration = SleepRules.durationMinutes(bedTime, wakeTime)
    return CalendarSleep(
        night = night.toString(),
        bedMinutes = bed,
        wakeMinutes = wake,
        alarm = alarm,
        changed = changed,
        prepMinutes = prep,
        fromMinutes = from,
        toMinutes = to,
        planBedMinutes = planBed?.minutes,
        planWakeMinutes = planWake?.minutes,
        durationMinutes = duration,
        goalMinutes = goalMinutes,
        meetsGoal = goalMinutes?.let { SleepRules.meetsGoal(duration, it) },
    )
}
