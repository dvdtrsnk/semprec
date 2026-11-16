package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.EventTaskEntry
import cz.semprec.app.domain.EventTaskState

/**
 * The tasks listed inside events, as entries of their own so that they can be opened and ticked off. They carry no
 * version, because the server lists a hosted task only by its id, title and state.
 */
internal fun hostedTasks(entries: List<CalendarEntry>): Map<String, CalendarEntry> =
    entries.filter { it.kind == CalendarEntryKind.EVENT }
        .flatMap { event -> event.tasks.map { task -> task.toEntry(event) } }
        .associateBy { it.id }

private fun EventTaskEntry.toEntry(event: CalendarEntry): CalendarEntry {
    val done = state == EventTaskState.DONE || state == EventTaskState.DONE_ELSEWHERE
    return CalendarEntry(
        id = id,
        kind = CalendarEntryKind.TASK,
        title = title,
        calendarId = null,
        date = event.date,
        endDate = null,
        timeFrom = null,
        timeTo = null,
        effectiveTo = null,
        allDay = true,
        status = if (done) CalendarEntry.STATUS_DONE else CalendarEntry.STATUS_OPEN,
        place = null,
        readOnly = false,
        updatedAt = null,
    )
}
