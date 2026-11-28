package cz.alldots.app.presentation

sealed interface HomeEffect {
    data class OpenDetail(val id: String) : HomeEffect
}
