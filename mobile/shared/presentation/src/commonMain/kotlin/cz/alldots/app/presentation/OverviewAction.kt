package cz.alldots.app.presentation

sealed interface OverviewAction {
    /** Loads again after a failure, showing the wait. */
    data object Retry : OverviewAction

    /** Reloads in place (pull to refresh); the content stays on screen. */
    data object Refresh : OverviewAction

    data class Open(val target: OverviewTarget) : OverviewAction
}
