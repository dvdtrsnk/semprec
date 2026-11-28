package cz.semprec.app.presentation

sealed interface JournalAction {
    /** Reads the selected period again; a period already shown stays on screen until the answer replaces it. */
    data object Retry : JournalAction

    /** Shows the period of [kind] that starts on [start] (`YYYY-MM-DD`). */
    data class Select(val kind: JournalPeriodKind, val start: String) : JournalAction

    data object GoToday : JournalAction

    /**
     * Shows the period of the selected kind [steps] periods after the selected one (before it for a negative
     * [steps]), as a turn of the page does.
     */
    data class Turn(val steps: Int) : JournalAction

    /**
     * Moves the windows of the time axis around [day] (`YYYY-MM-DD`), which the person dragged the axis to; the
     * selection and what the page shows stay as they are.
     */
    data class ShowAxisAround(val day: String) : JournalAction
    data class OpenEvent(val id: String) : JournalAction
    data object OpenInbox : JournalAction

    /** Makes the attachment [attachmentId] of the Inbox entry [entryId] ready for [JournalState.attachment]. */
    data class OpenAttachment(val entryId: String, val attachmentId: String) : JournalAction

    /** Ends the preview of an attachment, or its failure, and stops one being opened. */
    data object CloseAttachment : JournalAction
}

sealed interface JournalEffect {
    data class OpenEvent(val id: String) : JournalEffect
    data object OpenInbox : JournalEffect
}
