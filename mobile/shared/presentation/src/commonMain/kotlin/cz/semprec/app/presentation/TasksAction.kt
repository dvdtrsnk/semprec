package cz.semprec.app.presentation

import cz.semprec.app.core.TasksTab

sealed interface TasksAction {
    data class SelectTab(val tab: TasksTab) : TasksAction
    data object ToggleHideDone : TasksAction

    /** `null` is every project. */
    data class SetProject(val projectId: String?) : TasksAction
    data class SetFlaggedOnly(val flaggedOnly: Boolean) : TasksAction
    data object ClearFilters : TasksAction

    /** Loads the tasks again behind the failure screen. */
    data object Retry : TasksAction

    /** Loads the tasks again without leaving the list (pull to refresh). */
    data object Refresh : TasksAction
    data class ToggleDone(val taskId: String) : TasksAction
    data class Rename(val taskId: String, val title: String) : TasksAction

    /** A new task for today, in the chosen project. A blank title adds nothing. */
    data class Add(val title: String) : TasksAction
    data class OpenDetails(val taskId: String) : TasksAction
    data object DismissNotice : TasksAction
}

sealed interface TasksEffect {
    data class OpenDetails(val taskId: String) : TasksEffect
}
