package cz.semprec.app.presentation

import cz.semprec.app.core.LinkedValue
import cz.semprec.app.core.TaskRepeat

sealed interface ItemDetailsAction {
    /** Loads the item again behind the failure screen. */
    data object Retry : ItemDetailsAction
    data object DismissNotice : ItemDetailsAction

    /** Loads the projects and people a person can pick, once. */
    data object LoadChoices : ItemDetailsAction
    data class SetTitle(val title: String) : ItemDetailsAction
    data object ToggleDone : ItemDetailsAction
    data class SetDescription(val text: String) : ItemDetailsAction
    data class SetPlace(val text: String) : ItemDetailsAction
    data class SetFlagged(val flagged: Boolean) : ItemDetailsAction

    /** A new day; `null` removes the day (and so the times) of a task. An event always has a day. */
    data class SetDate(val date: String?) : ItemDetailsAction

    /** The start switch of a task: on starts at 9:00, off removes start and end. */
    data class SetTimed(val timed: Boolean) : ItemDetailsAction

    /** The end switch of a task: on ends half an hour after the start, off removes the end. */
    data class SetEnded(val ended: Boolean) : ItemDetailsAction
    data class SetTimeFrom(val time: String) : ItemDetailsAction
    data class SetTimeTo(val time: String) : ItemDetailsAction

    /** The all-day switch of an event. */
    data class SetAllDay(val allDay: Boolean) : ItemDetailsAction
    data class SetRepeat(val repeat: TaskRepeat) : ItemDetailsAction

    /** `null` is no project. */
    data class SelectProject(val projectId: String?) : ItemDetailsAction
    data class TogglePerson(val personId: String) : ItemDetailsAction
    data class RemoveFile(val fileId: String) : ItemDetailsAction

    /** Stops the project or the people following their source. */
    data class Unlink(val value: LinkedValue) : ItemDetailsAction

    /** Makes the project or the people follow their source again. */
    data class Relink(val value: LinkedValue) : ItemDetailsAction

    /** Moves the item to the trash. */
    data object Delete : ItemDetailsAction
}

sealed interface ItemDetailsEffect {
    /** The item is in the trash: the sheet closes. */
    data object Deleted : ItemDetailsEffect
}
