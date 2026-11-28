package cz.alldots.app.presentation

sealed interface PasswordResetAction {
    /** The person changed a field: an earlier failure of the password no longer applies. */
    data class Edited(val newPassword: String, val repeated: String) : PasswordResetAction

    data class Submit(val newPassword: String, val repeated: String) : PasswordResetAction
}
