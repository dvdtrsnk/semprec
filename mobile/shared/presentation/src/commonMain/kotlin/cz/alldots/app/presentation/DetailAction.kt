package cz.alldots.app.presentation

sealed interface DetailAction {
    data object Retry : DetailAction
}
