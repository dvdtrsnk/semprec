package cz.semprec.app.presentation

/** Requests of the calendar to the app: other screens it does not show itself. */
sealed interface CalendarEffect {
    /** Opens the details of an event or a task; [itemId] may be the id of a series occurrence. */
    data class OpenDetails(val itemId: String, val kind: CalendarItemKind, val day: String) : CalendarEffect

    data object OpenCalendars : CalendarEffect

    data object OpenInvitations : CalendarEffect

    data class OpenNewItem(val day: String) : CalendarEffect

    /** Opens the sleep of the evening [night] (`YYYY-MM-DD`). */
    data class OpenSleep(val night: String) : CalendarEffect
}
