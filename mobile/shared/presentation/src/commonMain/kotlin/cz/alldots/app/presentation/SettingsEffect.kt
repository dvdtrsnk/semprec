package cz.alldots.app.presentation

sealed interface SettingsEffect {
    data object ShowAbout : SettingsEffect
}
