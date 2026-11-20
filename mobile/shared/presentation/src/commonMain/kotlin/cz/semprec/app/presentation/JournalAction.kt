package cz.semprec.app.presentation

sealed interface JournalAction {
    /** Reads the selected period again. */
    data object Retry : JournalAction

    /** Shows the period of [kind] that starts on [start] (`YYYY-MM-DD`). */
    data class Select(val kind: JournalPeriodKind, val start: String) : JournalAction

    data object GoToday : JournalAction

    /**
     * Moves the windows of the time axis around [day] (`YYYY-MM-DD`), which the person dragged the axis to; the
     * selection and what the page shows stay as they are.
     */
    data class ShowAxisAround(val day: String) : JournalAction
    data class OpenEvent(val id: String) : JournalAction
    data object OpenInbox : JournalAction
}

sealed interface JournalEffect {
    data class OpenEvent(val id: String) : JournalEffect
    data object OpenInbox : JournalEffect
}
