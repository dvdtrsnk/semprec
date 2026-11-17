package cz.semprec.app.presentation

sealed interface HomeEffect {
    data class OpenDetail(val id: String) : HomeEffect
}
