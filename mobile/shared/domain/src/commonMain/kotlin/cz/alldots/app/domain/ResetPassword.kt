package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/**
 * Sets a new password with the token of a reset link, on the server the link came from. The new password and its
 * repeated entry must be equal and not empty ([accepts]); otherwise nothing is sent and the answer is
 * [FailureKind.REJECTED]. Whether the password is strong enough is the server's rule.
 */
class ResetPassword(private val auth: AuthRepository) {
    fun accepts(newPassword: String, repeated: String): Boolean = newPassword.isNotEmpty() && newPassword == repeated

    suspend operator fun invoke(
        serverUrl: String,
        token: String,
        newPassword: String,
        repeated: String,
    ): RepositoryResult<PasswordResetOutcome> {
        if (!accepts(newPassword, repeated)) return RepositoryResult.Failure(FailureKind.REJECTED)
        return auth.resetPassword(serverUrl, token, newPassword)
    }
}
