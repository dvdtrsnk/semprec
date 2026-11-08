package cz.semprec.app.presentation

sealed interface HomeAction {
    data object Retry : HomeAction
    data class SelectItem(val id: String) : HomeAction
}
