package cz.alldots.app.presentation

sealed interface ProfileAction {
    /** Reads the figures again after a failure. */
    data object Retry : ProfileAction

    data class Open(val page: AccountPage) : ProfileAction

    /** Sets the language of the account; a language the server does not offer is ignored. */
    data class ChangeLocale(val locale: String) : ProfileAction

    /** Asks the server to mail a link that sets a new password. */
    data object RequestPasswordReset : ProfileAction

    /** Ends the session of this device; the app then shows the sign-in. */
    data object SignOut : ProfileAction

    data object DismissFailure : ProfileAction
}
