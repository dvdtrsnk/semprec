package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class PasswordResetPhase { EDITING, SENDING, DONE, FAILED }

/** A refusal the server named: three for the link itself, one for the new password. */
enum class PasswordResetRefusalReason {
    LINK_INVALID,
    LINK_EXPIRED,
    LINK_USED,
    WEAK_PASSWORD,
}

/**
 * The "Set a new password" form of a reset link. The passwords stay in the native fields and are handed over by
 * [PasswordResetAction]. [canSubmit] is `true` while the two entries are equal and not empty and the form can be
 * sent. [PasswordResetPhase.DONE] means the password is set and the person signs in with it.
 * [PasswordResetPhase.FAILED] carries either [refusal], a refusal the server named, or [failure], any other failure;
 * both `null` is an unexpected failure. A refusal of the link is final: the form cannot be sent again with that link.
 */
data class PasswordResetState(
    val phase: PasswordResetPhase = PasswordResetPhase.EDITING,
    val canSubmit: Boolean = false,
    val refusal: PasswordResetRefusalReason? = null,
    val failure: FailureKind? = null,
)
