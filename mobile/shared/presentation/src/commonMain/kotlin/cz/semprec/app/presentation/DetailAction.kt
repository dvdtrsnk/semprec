package cz.semprec.app.presentation

sealed interface DetailAction {
    data object Retry : DetailAction
}
