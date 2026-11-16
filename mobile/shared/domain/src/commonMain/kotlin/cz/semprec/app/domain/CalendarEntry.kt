package cz.semprec.app.domain

/** What a calendar entry is: a stored event or task, or an entry the server derives and does not store. */
enum class CalendarEntryKind { EVENT, TASK, BIRTHDAY, HOLIDAY, SLEEP, TRACE }

/** What happened to a task in relation to one event it sits in (`GET /api/events/:id/tasks`). */
enum class EventTaskState { OPEN, MISSED, DONE, DONE_ELSEWHERE, MOVED }

/** A task that sits in an event, with its state there; [note] is the day or event name a state refers to. */
data class EventTaskEntry(val id: String, val title: String, val state: EventTaskState, val note: String?)

/** How the chain of a carried-over task ended on the day of a trace. */
enum class TraceOutcome { CARRIED, DONE, MOVED_TO_EVENT, MISSED }

/**
 * A night of sleep derived by the server (`kind` sleep): the evening it starts on, the times and whether they were
 * changed for this night alone. [prepReminderAt] is an ISO instant with the tenant zone's offset, or `null`.
 */
data class SleepNightEntry(
    val night: CalendarDay,
    val bedTime: ClockTime,
    val wakeTime: ClockTime,
    val alarm: Boolean,
    val changed: Boolean,
    val prepReminderAt: String?,
)

/**
 * One entry of the calendar timeline. [date] is the first day, [endDate] the stored last day of an event.
 * [timeFrom] and [timeTo] are what is stored, [effectiveTo] the end the server decides by the time rules (the start
 * for a task without an end); all are `null` for an all-day entry. For a derived entry only the fields its kind
 * uses are set, and it has no [updatedAt].
 */
data class CalendarEntry(
    val id: String,
    val kind: CalendarEntryKind,
    val title: String,
    val calendarId: String?,
    val date: CalendarDay,
    val endDate: CalendarDay?,
    val timeFrom: ClockTime?,
    val timeTo: ClockTime?,
    val effectiveTo: ClockTime?,
    val allDay: Boolean,
    val status: String?,
    val place: String?,
    val readOnly: Boolean,
    val updatedAt: String?,
    val seriesId: String? = null,
    val occurrenceDate: CalendarDay? = null,
    val tentative: Boolean = false,
    val tasks: List<EventTaskEntry> = emptyList(),
    val hostEventTitle: String? = null,
    val carriedFrom: CalendarDay? = null,
    val trace: TraceOutcome? = null,
    val traceNote: String? = null,
    val sourceTaskId: String? = null,
    val sleep: SleepNightEntry? = null,
) {
    /** Whether a task is done. */
    val isDone: Boolean get() = status == STATUS_DONE

    /** Whether a task was left undone on its day (the nightly job marks it). */
    val isMissed: Boolean get() = status == STATUS_MISSED

    /** The stored schedule, what a move or a resize changes. */
    val schedule: CalendarSchedule get() = CalendarSchedule(date, endDate, timeFrom, timeTo)

    /** Whether this is a series occurrence that is not a stored row yet. */
    val isVirtualOccurrence: Boolean get() = seriesId != null && readOnly

    companion object {
        const val STATUS_DONE: String = "done"
        const val STATUS_MISSED: String = "missed"
        const val STATUS_OPEN: String = "notDone"
    }
}

/** A date, an optional last day and an optional start and end: the four values an event or a task stores. */
data class CalendarSchedule(
    val date: CalendarDay,
    val endDate: CalendarDay?,
    val timeFrom: ClockTime?,
    val timeTo: ClockTime?,
) {
    val allDay: Boolean get() = timeFrom == null
}

/** The timeline the server returned for a range: [today] and [nowMinutes] are read in the tenant zone. */
data class CalendarTimeline(
    val timezone: String,
    val today: CalendarDay,
    val nowMinutes: Int,
    val from: CalendarDay,
    val to: CalendarDay,
    val entries: List<CalendarEntry>,
)
