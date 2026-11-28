package cz.alldots.app.presentation

sealed interface SettingsAction {
    data class SelectRow(val row: SettingsRow) : SettingsAction
}
