package cz.alldots.app.presentation

sealed interface DevicesAction {
    data object Retry : DevicesAction

    /** Asks to confirm signing out the device [deviceId]; an id that is not one of the other devices is ignored. */
    data class Ask(val deviceId: String) : DevicesAction

    /** Asks to confirm signing out every other device. */
    data object AskOthers : DevicesAction

    data object Cancel : DevicesAction

    /** Signs out what the open confirmation names. */
    data object Confirm : DevicesAction

    data object DismissFailure : DevicesAction
}
