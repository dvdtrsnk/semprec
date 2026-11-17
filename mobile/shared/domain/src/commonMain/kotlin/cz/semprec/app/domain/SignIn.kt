package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Signs a person in. Blank credentials or an unreadable server address are refused before any request is made. */
class SignIn(private val auth: AuthRepository) {
    suspend operator fun invoke(serverInput: String, email: String, password: String): RepositoryResult<Session> {
        val serverUrl = normalizeServerUrl(serverInput)
        val trimmedEmail = email.trim()
        if (serverUrl == null || trimmedEmail.isEmpty() || password.isEmpty()) {
            return RepositoryResult.Failure(FailureKind.REJECTED)
        }
        return auth.signIn(serverUrl, trimmedEmail, password)
    }
}
