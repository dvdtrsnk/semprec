package cz.semprec.app.presentation

import cz.semprec.app.core.MailSignalField

sealed interface ProjectMailSignalsAction {
    /** Loads the signals again after a failed load. */
    data object Retry : ProjectMailSignalsAction

    /** The text typed into the field of one list. */
    data class EditInput(val field: MailSignalField, val text: String) : ProjectMailSignalsAction

    /** Adds the text typed into the field of [field] to that list. */
    data class Add(val field: MailSignalField) : ProjectMailSignalsAction

    data class Remove(val field: MailSignalField, val value: String) : ProjectMailSignalsAction

    data object Save : ProjectMailSignalsAction

    /** Gives the project to the open threads the saved signals match, as a fresh preview of them lists. */
    data object Assign : ProjectMailSignalsAction

    data object RetryPreview : ProjectMailSignalsAction

    /** Hides what the last assignment did. */
    data object DismissAssignment : ProjectMailSignalsAction

    /** Hides a failed save or assignment. */
    data object DismissFailure : ProjectMailSignalsAction
}
