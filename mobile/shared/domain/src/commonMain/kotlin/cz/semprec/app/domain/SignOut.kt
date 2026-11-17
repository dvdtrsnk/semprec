package cz.semprec.app.domain

/** Ends the session of this device. */
class SignOut(private val auth: AuthRepository) {
    suspend operator fun invoke() = auth.signOut()
}
