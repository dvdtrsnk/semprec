package cz.semprec.app.presentation

sealed interface SettingsEffect {
    data object ShowAbout : SettingsEffect
}
