package cz.semprec.app.presentation

sealed interface SessionAction {
    /** Checks the stored session again, after the server could not be reached. */
    data object Retry : SessionAction
    data object SignOut : SessionAction
}
