package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/** Asks for a password-reset link. A blank address or an unreadable server address is refused before any request. */
class RequestPasswordReset(private val auth: AuthRepository) {
    suspend operator fun invoke(serverInput: String, email: String): RepositoryResult<Unit> {
        val serverUrl = normalizeServerUrl(serverInput)
        val trimmedEmail = email.trim()
        if (serverUrl == null || trimmedEmail.isEmpty()) return RepositoryResult.Failure(FailureKind.REJECTED)
        return auth.requestPasswordReset(serverUrl, trimmedEmail)
    }
}
