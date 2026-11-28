package cz.alldots.app.domain

/** Checks the session stored on this device when the app starts. */
class RestoreSession(private val auth: AuthRepository) {
    suspend operator fun invoke() = auth.restore()
}
