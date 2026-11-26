package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

/** How much of the calendar a screen shows: a year of months, a month of days, or one day hour by hour. */
enum class CalendarZoom { YEAR, MONTH, DAY }

enum class CalendarPhase { LOADING, CONTENT, ERROR }

/** What an item of the calendar is. Birthdays, holidays, sleep nights and traces are not stored by the user. */
enum class CalendarItemKind { EVENT, TASK, BIRTHDAY, HOLIDAY, SLEEP, TRACE }

/** What happened to a task in relation to the event it sits in. */
enum class CalendarTaskInEvent { OPEN, MISSED, DONE, DONE_ELSEWHERE, MOVED }

/** How the chain of a carried-over task ended on the day of a trace. */
enum class CalendarTraceOutcome { CARRIED, DONE, MOVED_TO_EVENT, MISSED }

/** The edge of a timed item a handle drags. */
enum class CalendarEdge { START, END }

/** What the clipboard of the calendar does when it is pasted: moves the item (cut) or copies it. */
enum class CalendarClipboardMode { CUT, COPIED }

/** A task that sits in an event; [note] is the day or the event a state refers to (`YYYY-MM-DD` or a name). */
data class CalendarEventTask(
    val id: String,
    val title: String,
    val state: CalendarTaskInEvent,
    val note: String?,
)

/**
 * The part of one night of sleep that falls on one day: [bedMinutes] and [wakeMinutes] are the night's times of day,
 * the night belongs to the evening [night] (`YYYY-MM-DD`). The band on this day runs from [fromMinutes] to
 * [toMinutes] and is empty when they are equal. [prepMinutes] is when the bedtime reminder comes on this day, or
 * `null` when it comes on another day or not at all. [planBedMinutes] and [planWakeMinutes] are the times of the plan
 * the night follows, or departs from when [changed] (`null` without a plan). [durationMinutes] is how long the night
 * is, [goalMinutes] the sleep goal (`null` when unknown); [meetsGoal] tells whether the night is at least as long as
 * the goal (`null` without a goal).
 */
data class CalendarSleep(
    val night: String,
    val bedMinutes: Int,
    val wakeMinutes: Int,
    val alarm: Boolean,
    val changed: Boolean,
    val prepMinutes: Int?,
    val fromMinutes: Int,
    val toMinutes: Int,
    val planBedMinutes: Int? = null,
    val planWakeMinutes: Int? = null,
    val durationMinutes: Int = 0,
    val goalMinutes: Int? = null,
    val meetsGoal: Boolean? = null,
)

/**
 * The night a finger moves or stretches: the snapped times it would have, and the parts it would have on its evening
 * [night] and on the morning after, [morningDay], as [CalendarSleep] cuts them (`null` where nothing of it would fall).
 */
data class CalendarSleepDrag(
    val night: String,
    val bedMinutes: Int,
    val wakeMinutes: Int,
    val committing: Boolean,
    val evening: CalendarSleep? = null,
    val morning: CalendarSleep? = null,
    val morningDay: String = "",
)

/**
 * One item of one day. [startMinutes] is `null` for an all-day item; [endMinutes] is where a timed item is drawn to
 * (a short block when it has no end of its own, [hasEnd] `false`). [column] and [columns] place a timed item next
 * to the ones it overlaps, [depth] steps it in from the left of its column when it starts well after one it overlaps
 * (drawn over it). [color] is the colour of its calendar, `#RRGGBB`. [editable] tells whether it can be
 * moved, finished or removed. [timeFrom] and [timeTo] are its own start and end as times of day, whichever day it is
 * drawn on: the stored ones, [timeTo] the end the server decides for an event without a stored end; both are `null`
 * for an item without a time.
 */
data class CalendarItem(
    val id: String,
    val kind: CalendarItemKind,
    val title: String,
    val color: String,
    val date: String,
    val endDate: String?,
    val allDay: Boolean,
    val startMinutes: Int?,
    val endMinutes: Int?,
    val hasEnd: Boolean,
    val done: Boolean,
    val missed: Boolean,
    val place: String?,
    val tentative: Boolean,
    val editable: Boolean,
    val column: Int,
    val columns: Int,
    val depth: Int,
    val tasks: List<CalendarEventTask>,
    val hostEventTitle: String?,
    val carriedFrom: String?,
    val trace: CalendarTraceOutcome?,
    val traceNote: String?,
    val timeFrom: Int?,
    val timeTo: Int?,
)

/** A day of the window: its items, and the sleep that ends on it (the morning band) and starts on it (evening). */
data class CalendarDayState(
    val date: String,
    val items: List<CalendarItem>,
    val sleepEvening: CalendarSleep?,
    val sleepMorning: CalendarSleep?,
)

/** A month of the year view: [leading] empty cells before the first (the week starts on Monday), then [length] days. */
data class CalendarMonthState(val year: Int, val month: Int, val leading: Int, val length: Int)

/**
 * The item being dragged and where it would land: the snapped [startMinutes] and [endMinutes] (both `null` all
 * day) on [date], or into the event [intoEventId] when a task is over an event. [committing] is `true` from the drop
 * until the answer of the server is shown.
 */
data class CalendarDrag(
    val itemId: String,
    val date: String,
    val allDay: Boolean,
    val startMinutes: Int?,
    val endMinutes: Int?,
    val intoEventId: String?,
    val committing: Boolean,
)

/** What the clipboard holds: the [title] of the cut or copied item. */
data class CalendarClipboard(val mode: CalendarClipboardMode, val title: String)

/**
 * The calendar. [days] are the days of the loaded window, the six weeks of the selected month and a week before and
 * after (57 days), [monthGrid] the 42 days of the month view in order. [months] are the twelve months of the year of
 * [selectedDay]. [nowMinutes] is the time of day on [today], in the zone of the server, [timezone] (an IANA name,
 * empty until the server first answers); every time of the state is in that zone. [problem] is `true` after a
 * write that failed, with [problemFailure] as its reason (`null` for an unexpected one).
 */
data class CalendarState(
    val phase: CalendarPhase,
    val failure: FailureKind?,
    val zoom: CalendarZoom,
    val selectedDay: String,
    val today: String,
    val nowMinutes: Int,
    val timezone: String,
    val days: List<CalendarDayState>,
    val monthGrid: List<String>,
    val months: List<CalendarMonthState>,
    val pendingInvitations: Int,
    val selectedItemId: String?,
    val drag: CalendarDrag?,
    val sleepDrag: CalendarSleepDrag?,
    val clipboard: CalendarClipboard?,
    val busy: Boolean,
    val problem: Boolean,
    val problemFailure: FailureKind?,
)
