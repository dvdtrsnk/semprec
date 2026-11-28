package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ResetPasswordTest {
    @Test fun `matching passwords are sent with the token to the server of the link`() = runTest {
        val auth = RecordingAuth()
        val result = ResetPassword(auth)("https://alldots.app", "tok", "new secret", "new secret")
        assertEquals(PasswordResetOutcome.Done, assertIs<RepositoryResult.Content<PasswordResetOutcome>>(result).value)
        assertEquals(listOf(Triple("https://alldots.app", "tok", "new secret")), auth.passwordResets)
    }

    @Test fun `passwords that differ or are empty are rejected without a request`() = runTest {
        val auth = RecordingAuth()
        val refused = listOf("a" to "b", "" to "", "secret" to "", "" to "secret", "secret" to "secret ")
        for ((password, repeated) in refused) {
            assertFalse(ResetPassword(auth).accepts(password, repeated))
            val result = ResetPassword(auth)("https://alldots.app", "tok", password, repeated)
            assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
        }
        assertTrue(auth.passwordResets.isEmpty())
        assertTrue(ResetPassword(auth).accepts(" s ", " s "))
    }

    @Test fun `the server's refusal and failure are handed on unchanged`() = runTest {
        val refused = RepositoryResult.Content(PasswordResetOutcome.Refused(PasswordResetRefusal.TOKEN_EXPIRED))
        val failed = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        for (answer in listOf(refused, failed)) {
            val auth = RecordingAuth(resetAnswer = answer)
            assertEquals(answer, ResetPassword(auth)("https://alldots.app", "tok", "secret", "secret"))
        }
    }
}
