package cz.semprec.app.presentation

/** Lists the settings rows; selecting a row asks the native owner to present it. */
class SettingsViewModel internal constructor() :
    ScreenViewModel<SettingsState, SettingsAction, SettingsEffect>(SettingsState()) {
    override fun onAction(action: SettingsAction) {
        if (isClosed) return
        when (action) {
            is SettingsAction.SelectRow -> emit(action.row.effect())
        }
    }
}

private fun SettingsRow.effect(): SettingsEffect = when (this) {
    SettingsRow.ABOUT -> SettingsEffect.ShowAbout
}
