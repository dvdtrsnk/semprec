package cz.alldots.app.presentation

sealed interface LoginAction {
    data class SignIn(val server: String, val email: String, val password: String) : LoginAction
    data class ForgotPassword(val server: String, val email: String) : LoginAction

    /** The person changed a field: an earlier failure or reset notice no longer applies. */
    data object Edited : LoginAction
}
