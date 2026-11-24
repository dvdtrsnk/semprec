package cz.semprec.app.presentation

/**
 * What a person does on the calendar; the gesture layer reports positions as raw minutes of the day. The actions
 * come in four groups, each handled apart: moving around, working on an item in place, changing the data beyond a
 * move, and opening other screens.
 */
sealed interface CalendarAction {
    /** Moving around the calendar and loading it. */
    sealed interface Navigation : CalendarAction {
        data object Retry : Navigation

        /** Reloads the window, for example when the app comes back to the front. */
        data object Refresh : Navigation

        /** Shows [zoom] around [day] (`YYYY-MM-DD`). */
        data class Show(val zoom: CalendarZoom, val day: String) : Navigation

        /** One step of the shown zoom: a day, a month or a year, forward for a positive [steps]. */
        data class Page(val steps: Int) : Navigation

        data object GoToday : Navigation
    }

    /** Taps, selection, dragging and finishing a task: what is done with an item in place. */
    sealed interface Gesture : CalendarAction {
        /** A tap on an item: it opens, unless another item is selected, in which case the tap only deselects. */
        data class Tap(val itemId: String) : Gesture

        /** A tap beside the items: it deselects. */
        data object TapBackground : Gesture

        /** A long press on an item selects it. */
        data class Select(val itemId: String) : Gesture

        data class ToggleDone(val itemId: String) : Gesture

        /** The item is dragged to [day]; [rawStart] is where its top is, in minutes, unless over the all-day row. */
        data class DragMove(
            val itemId: String,
            val day: String,
            val rawStart: Int,
            val overAllDayRow: Boolean,
            val overEventId: String?,
        ) : Gesture

        /** A handle is dragged to [rawMinutes]. */
        data class DragResize(val itemId: String, val edge: CalendarEdge, val rawMinutes: Int) : Gesture

        /** The finger lifted: [commit] writes the move, otherwise it is dropped. */
        data class EndDrag(val commit: Boolean) : Gesture

        /** The item is dropped on a day of the month view. */
        data class MoveToDay(val itemId: String, val day: String) : Gesture
    }

    /** The clipboard, copies and deletes. */
    sealed interface Edit : CalendarAction {
        data class Cut(val itemId: String) : Edit

        data class Copy(val itemId: String) : Edit

        data class Duplicate(val itemId: String) : Edit

        /** Pastes the clipboard on [day], at [rawStart] unless [allDay]. */
        data class Paste(val day: String, val rawStart: Int, val allDay: Boolean) : Edit

        /** Deletes the item at once, as the system Calendar does; the server keeps it restorable for 30 days. */
        data class Delete(val itemId: String) : Edit

        data object DismissProblem : Edit
    }

    /** Opening the screens the calendar does not show itself. */
    sealed interface Open : CalendarAction {
        data object Calendars : Open

        data object Invitations : Open

        data class NewItem(val day: String) : Open

        data class Sleep(val night: String) : Open

        /** The calendar as a list from [day] (`YYYY-MM-DD`) on. */
        data class Agenda(val day: String) : Open
    }
}
