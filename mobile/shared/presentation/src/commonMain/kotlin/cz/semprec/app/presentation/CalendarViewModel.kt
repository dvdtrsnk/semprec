package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.EditCalendarEntry
import cz.semprec.app.domain.LoadCalendarWindow
import cz.semprec.app.domain.ScheduleEditing
import cz.semprec.app.domain.isEditable

/**
 * The calendar: a year of months, a month of days or one day hour by hour, with the events and tasks of the
 * window around the selected day, and the gestures that move, resize, copy, finish and remove them. Which schedule
 * a gesture means is decided by the scheduling rules of the domain; this class only sequences them.
 */
class CalendarViewModel internal constructor(
    initialDay: String,
    loadWindow: LoadCalendarWindow,
    changes: CalendarChanges,
    edit: EditCalendarEntry,
) : CalendarGestureViewModel(initialDay, loadWindow, changes, edit) {
    private var copied: CalendarEntry? = null

    init {
        start()
    }

    override fun onAction(action: CalendarAction) {
        if (isClosed) return
        when (action) {
            is CalendarAction.Navigation -> navigation(action)
            is CalendarAction.Gesture -> gesture(action)
            is CalendarAction.Edit -> editing(action)
            is CalendarAction.Open -> open(action)
        }
    }

    private fun navigation(action: CalendarAction.Navigation) {
        when (action) {
            CalendarAction.Navigation.Retry -> retry()
            CalendarAction.Navigation.Refresh -> if (state.value.drag == null && !state.value.busy) reload()
            is CalendarAction.Navigation.Show -> CalendarDay.parse(action.day)?.let { navigate(action.zoom, it) }
            is CalendarAction.Navigation.Page -> page(action.steps)
            CalendarAction.Navigation.GoToday ->
                CalendarDay.parse(state.value.today)?.let { navigate(state.value.zoom, it) }
        }
    }

    private fun gesture(action: CalendarAction.Gesture) {
        when (action) {
            is CalendarAction.Gesture.Tap -> tap(action.itemId)
            CalendarAction.Gesture.TapBackground -> if (state.value.drag == null) {
                update { it.copy(selectedItemId = null) }
            }
            is CalendarAction.Gesture.Select -> select(action.itemId)
            is CalendarAction.Gesture.ToggleDone -> toggleDone(action.itemId)
            is CalendarAction.Gesture.DragMove -> dragMove(action)
            is CalendarAction.Gesture.DragResize -> dragResize(action)
            is CalendarAction.Gesture.EndDrag -> endDrag(action.commit)
            is CalendarAction.Gesture.MoveToDay -> moveToDay(action.itemId, action.day)
        }
    }

    private fun editing(action: CalendarAction.Edit) {
        when (action) {
            is CalendarAction.Edit.Cut -> hold(action.itemId, CalendarClipboardMode.CUT)
            is CalendarAction.Edit.Copy -> hold(action.itemId, CalendarClipboardMode.COPIED)
            is CalendarAction.Edit.Duplicate -> duplicate(action.itemId)
            is CalendarAction.Edit.Paste -> paste(action)
            is CalendarAction.Edit.RequestDelete -> requestDelete(action.itemId)
            CalendarAction.Edit.ConfirmDelete -> confirmDelete()
            CalendarAction.Edit.CancelDelete -> update { it.copy(pendingDelete = null) }
            CalendarAction.Edit.DismissProblem -> update { it.copy(problem = false, problemFailure = null) }
        }
    }

    private fun open(action: CalendarAction.Open) {
        emit(
            when (action) {
                CalendarAction.Open.Calendars -> CalendarEffect.OpenCalendars
                CalendarAction.Open.Invitations -> CalendarEffect.OpenInvitations
                is CalendarAction.Open.NewItem -> CalendarEffect.OpenNewItem(action.day)
                is CalendarAction.Open.Sleep -> CalendarEffect.OpenSleep(action.night)
                is CalendarAction.Open.Agenda -> CalendarEffect.OpenAgenda(action.day)
            },
        )
    }

    private fun moveToDay(itemId: String, day: String) {
        val entry = entryOf(itemId)
        val target = CalendarDay.parse(day)
        if (entry != null && target != null && entry.isEditable) {
            val schedule = ScheduleEditing.toDay(entry.schedule, target)
            if (schedule != entry.schedule) write { edit.reschedule(entry, schedule) }
        }
        update { it.copy(selectedItemId = null) }
    }

    private fun hold(itemId: String, mode: CalendarClipboardMode) {
        val entry = entryOf(itemId)
        if (entry != null && entry.isEditable) {
            copied = entry
            update { it.copy(clipboard = CalendarClipboard(mode, entry.title), selectedItemId = null) }
        }
    }

    private fun duplicate(itemId: String) {
        val entry = entryOf(itemId)
        update { it.copy(selectedItemId = null) }
        if (entry != null) write { edit.duplicate(entry, entry.schedule) }
    }

    private fun paste(action: CalendarAction.Edit.Paste) {
        val entry = copied
        val mode = state.value.clipboard?.mode
        val day = CalendarDay.parse(action.day)
        if (entry == null || mode == null || day == null) return
        val schedule = pasteSchedule(entry, day, action)
        when (mode) {
            CalendarClipboardMode.COPIED -> write { edit.duplicate(entry, schedule) }
            CalendarClipboardMode.CUT -> {
                write { edit.reschedule(entry, schedule) }
                copied = null
                update { it.copy(clipboard = null) }
            }
        }
    }

    private fun requestDelete(itemId: String) {
        val entry = entryOf(itemId)
        if (entry != null && entry.isEditable) {
            update { it.copy(pendingDelete = CalendarDeleteRequest(itemId, entry.title, entry.kind.toItemKind())) }
        }
    }

    private fun confirmDelete() {
        val request = state.value.pendingDelete
        val entry = request?.let { entryOf(it.itemId) }
        update { it.copy(pendingDelete = null, selectedItemId = null) }
        if (entry != null) write { edit.delete(entry) }
    }
}

/** Where a pasted copy lands: at the place that was held, in the all-day row or at a time of the day. */
private fun pasteSchedule(
    entry: CalendarEntry,
    day: CalendarDay,
    action: CalendarAction.Edit.Paste
): CalendarSchedule = when {
    action.allDay && entry.schedule.allDay -> ScheduleEditing.toDay(entry.schedule, day)
    action.allDay -> ScheduleEditing.toAllDay(entry.schedule, day)
    else -> ScheduleEditing.moveTo(entry.kind, entry.schedule, day, action.rawStart)
}
