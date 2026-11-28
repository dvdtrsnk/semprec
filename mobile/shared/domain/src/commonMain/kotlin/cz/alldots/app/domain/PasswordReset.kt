package cz.alldots.app.domain

/** Why the server refused to set a new password with a reset link. */
enum class PasswordResetRefusal {
    /** The server does not know the link's token. */
    TOKEN_INVALID,

    /** The link is older than the server accepts. */
    TOKEN_EXPIRED,

    /** The link already set a password. */
    TOKEN_CONSUMED,

    /** The new password does not meet the server's rules; the link stays usable. */
    WEAK_PASSWORD,
}

/** The answer of setting a new password with a reset link. */
sealed interface PasswordResetOutcome {
    /** The password is set; the person signs in with it. */
    data object Done : PasswordResetOutcome

    data class Refused(val refusal: PasswordResetRefusal) : PasswordResetOutcome
}
