package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.EditCalendarEntry
import cz.semprec.app.domain.LoadCalendarWindow
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.ScheduleEditing
import cz.semprec.app.domain.isEditable
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * Selection, taps, dragging and the writes they lead to. A drag keeps a preview in the state, computed by the
 * scheduling rules of the domain from the raw minutes the gesture reports; the drop writes it, and the preview stays
 * until the answer of the server is shown. While a write runs, further writes are ignored.
 */
abstract class CalendarGestureViewModel internal constructor(
    initialDay: String,
    loadWindow: LoadCalendarWindow,
    changes: CalendarChanges,
    internal val edit: EditCalendarEntry,
) : CalendarWindowViewModel(initialDay, loadWindow, changes) {
    private var writeJob: Job? = null
    private var dragSchedule: Schedule? = null

    internal fun tap(itemId: String) {
        val selected = state.value.selectedItemId
        if (selected != null && selected != itemId) {
            update { it.copy(selectedItemId = null) }
            return
        }
        update { it.copy(selectedItemId = null) }
        entryOf(itemId)?.let { emit(CalendarEffect.OpenDetails(itemId, it.kind.toItemKind(), it.date.toString())) }
    }

    internal fun select(itemId: String) {
        if (entryOf(itemId)?.isEditable == true) update { it.copy(selectedItemId = itemId) }
    }

    internal fun dragMove(action: CalendarAction.Gesture.DragMove) {
        val entry = entryOf(action.itemId)
        val day = CalendarDay.parse(action.day)
        if (entry == null || day == null || !canDrag(entry)) return
        val host = action.overEventId?.let { entryOf(it) }?.takeIf { entry.canBePutInto(it) }
        val schedule = when {
            host != null -> entry.schedule
            action.overAllDayRow -> ScheduleEditing.toAllDay(entry.schedule, day)
            else -> ScheduleEditing.moveTo(entry.kind, entry.schedule, day, action.rawStart)
        }
        preview(entry, schedule, host?.id)
    }

    internal fun dragResize(action: CalendarAction.Gesture.DragResize) {
        val entry = entryOf(action.itemId)
        if (entry == null || !canDrag(entry)) return
        val schedule = when (action.edge) {
            CalendarEdge.START -> ScheduleEditing.resizeStart(entry.schedule, action.rawMinutes)
            CalendarEdge.END -> ScheduleEditing.resizeEnd(entry.schedule, action.rawMinutes)
        }
        preview(entry, schedule, null)
    }

    /** The finger lifted: write the previewed move, or drop it. */
    internal fun endDrag(commit: Boolean) {
        val drag = state.value.drag
        val entry = drag?.let { entryOf(it.itemId) }
        val schedule = dragSchedule
        if (drag == null || drag.committing) return
        if (!commit || entry == null || schedule == null) {
            dragSchedule = null
            update { it.copy(drag = null) }
            return
        }
        update { it.copy(drag = drag.copy(committing = true), selectedItemId = null) }
        val host = drag.intoEventId?.let { entryOf(it) }
        write {
            if (host != null) edit.putTaskInEvent(entry, host) else edit.reschedule(entry, schedule)
        }
    }

    internal fun toggleDone(itemId: String) {
        entryOf(itemId)?.let { entry -> write { edit.toggleDone(entry) } }
    }

    /** Runs a write; the window reloads when it is done, which also takes the preview of a drag away. */
    internal fun <T> write(operation: suspend () -> RepositoryResult<T>) {
        if (state.value.busy) return
        update { it.copy(busy = true, problem = false, problemFailure = null) }
        writeJob?.cancel()
        writeJob = viewModelScope.launch {
            val result = guarded(operation)
            ensureActive()
            dragSchedule = null
            when (result) {
                is RepositoryResult.Content -> reload()
                is RepositoryResult.Failure -> writeFailed(result.kind)
                null -> writeFailed(null)
            }
        }
    }

    private fun canDrag(entry: CalendarEntry): Boolean = entry.isEditable && state.value.drag?.committing != true

    private fun preview(entry: CalendarEntry, schedule: Schedule, intoEventId: String?) {
        dragSchedule = schedule
        val timed = !schedule.allDay
        update {
            it.copy(
                selectedItemId = entry.id,
                drag = CalendarDrag(
                    itemId = entry.id,
                    date = schedule.date.toString(),
                    allDay = schedule.allDay,
                    startMinutes = schedule.timeFrom?.minutes,
                    endMinutes = if (timed) ScheduleEditing.visibleEnd(schedule) else null,
                    intoEventId = intoEventId,
                    committing = false,
                ),
            )
        }
    }

    private fun writeFailed(kind: FailureKind?) {
        update { it.copy(busy = false, drag = null, problem = true, problemFailure = kind) }
    }
}

/** Whether this task may be dropped into [event]: another event, stored or a series occurrence. */
private fun CalendarEntry.canBePutInto(event: CalendarEntry): Boolean =
    kind == CalendarEntryKind.TASK && event.kind == CalendarEntryKind.EVENT && event.id != id && event.isEditable

internal fun CalendarEntryKind.toItemKind(): CalendarItemKind = when (this) {
    CalendarEntryKind.EVENT -> CalendarItemKind.EVENT
    CalendarEntryKind.TASK -> CalendarItemKind.TASK
    CalendarEntryKind.BIRTHDAY -> CalendarItemKind.BIRTHDAY
    CalendarEntryKind.HOLIDAY -> CalendarItemKind.HOLIDAY
    CalendarEntryKind.SLEEP -> CalendarItemKind.SLEEP
    CalendarEntryKind.TRACE -> CalendarItemKind.TRACE
}
