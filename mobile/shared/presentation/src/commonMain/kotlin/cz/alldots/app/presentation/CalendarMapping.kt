package cz.alldots.app.presentation

import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.CalendarInfo
import cz.alldots.app.domain.ClockTime
import cz.alldots.app.domain.ScheduleEditing
import cz.alldots.app.domain.layoutTimeline

private const val DEFAULT_COLOR = "#8E8E93"
private const val GRID_DAYS = 42
private const val MONTHS_IN_YEAR = 12
private const val SYSTEM_SLEEP = "sleep"
private const val SYSTEM_TASKS = "tasks"

/** The 42 days of the month view of [day]: from the Monday of its first week, six weeks. */
internal fun monthGridOf(day: CalendarDay): List<String> {
    val start = day.startOfMonth().startOfWeek()
    return (0 until GRID_DAYS).map { start.plusDays(it).toString() }
}

internal fun monthsOf(year: Int): List<CalendarMonthState> = (1..MONTHS_IN_YEAR).map { month ->
    val first = CalendarDay(year, month, 1)
    CalendarMonthState(year, month, first.isoDayOfWeek - 1, first.lengthOfMonth())
}

/** The colour of the calendar an entry belongs to; derived entries follow the system calendar of their kind. */
internal class CalendarColors(calendars: List<CalendarInfo>) {
    private val byId = calendars.associateBy { it.id }
    private val bySystem = calendars.mapNotNull { calendar -> calendar.systemKey?.let { it to calendar.color } }.toMap()

    fun of(entry: CalendarEntry): String {
        val own = entry.calendarId?.let { byId[it]?.color }
        val system = when (entry.kind) {
            CalendarEntryKind.SLEEP -> bySystem[SYSTEM_SLEEP]
            CalendarEntryKind.TRACE -> bySystem[SYSTEM_TASKS]
            else -> null
        }
        return own ?: system ?: DEFAULT_COLOR
    }
}

/** The days of the window with their items laid out, and the sleep bands that fall on each. */
internal fun dayStatesOf(
    entries: List<CalendarEntry>,
    from: CalendarDay,
    to: CalendarDay,
    colors: CalendarColors,
): List<CalendarDayState> {
    val nights = entries.mapNotNull { entry -> entry.sleep?.let { it.night to it } }.toMap()
    val days = generateSequence(from) { if (it < to) it.plusDays(1) else null }.toList()
    return days.map { day ->
        val items = entries.filter { it.kind != CalendarEntryKind.SLEEP && it.occursOn(day) }
        CalendarDayState(
            date = day.toString(),
            items = items.laidOut(day, colors),
            sleepEvening = nights[day]?.toState(day),
            sleepMorning = nights[day.plusDays(-1)]?.toState(day),
        )
    }
}

private fun CalendarEntry.occursOn(day: CalendarDay): Boolean {
    val last = endDate
    return date == day || (kind == CalendarEntryKind.EVENT && last != null && date < day && day <= last)
}

private fun CalendarEntry.spansDays(): Boolean {
    val last = endDate
    return kind == CalendarEntryKind.EVENT && last != null && last > date
}

private fun List<CalendarEntry>.laidOut(day: CalendarDay, colors: CalendarColors): List<CalendarItem> {
    val timed = mapNotNull { entry -> entry.timedRange(day)?.let { entry to it } }
    val lanes = layoutTimeline(timed.map { it.second })
    val laneOf = timed.zip(lanes).associate { (timedEntry, lane) -> timedEntry.first.id to lane }
    return map { entry -> entry.toItem(day, colors.of(entry), laneOf[entry.id]) }
}

/**
 * Where an entry is drawn on [day], in minutes of the day, or `null` when it is not a block of that day's timeline: an
 * all-day or multi-day entry, or a kind without a time. A timed event that runs past midnight within a day is drawn
 * from its start to midnight on its first day and from midnight to its end on its last; a longer one is shown in the
 * all-day row on each of its days, as the system Calendar does. A real end is kept as it is, however short the
 * block; an entry without one is drawn to the end the server decides, or to a short block after its start.
 */
internal fun CalendarEntry.timedRange(day: CalendarDay): IntRange? {
    val from = timeFrom?.minutes
    val timedKind = kind == CalendarEntryKind.EVENT || kind == CalendarEntryKind.TASK || kind == CalendarEntryKind.TRACE
    val last = endDate
    return when {
        from == null || !timedKind -> null
        spansDays() && last != null -> spanningRange(day, from, last)
        date != day -> null
        else -> ownDayRange(from)
    }
}

/** An event over midnight of less than a day: to midnight on its first day, from midnight on its last. */
private fun CalendarEntry.spanningRange(day: CalendarDay, from: Int, last: CalendarDay): IntRange? {
    val to = timeTo?.minutes ?: return null
    val minutesLong = (last.epochDay - date.epochDay).toInt() * ClockTime.DAY_MINUTES + to - from
    return when {
        minutesLong > ClockTime.DAY_MINUTES -> null
        day == date -> from..ClockTime.DAY_MINUTES
        day == last -> 0..to
        else -> null
    }
}

/** A real end as it is, else the end the server decides or a short block after the start. */
private fun CalendarEntry.ownDayRange(from: Int): IntRange {
    val end = if (kind == CalendarEntryKind.EVENT) {
        effectiveTo?.minutes ?: ScheduleEditing.visibleEnd(schedule) ?: from
    } else {
        ScheduleEditing.visibleEnd(schedule) ?: from
    }
    val drawnTo = if (timeTo != null) maxOf(end, from) else maxOf(end, from + ScheduleEditing.STEP_MINUTES)
    return from..drawnTo.coerceAtMost(ClockTime.DAY_MINUTES)
}

/** Whether [day] is the first day of an event that runs past its midnight, so its end is not on this day. */
internal fun CalendarEntry.continuesAfter(day: CalendarDay): Boolean = spansDays() && day == date && timeFrom != null
