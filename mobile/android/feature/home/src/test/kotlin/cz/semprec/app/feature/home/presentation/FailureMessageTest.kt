package cz.semprec.app.feature.home.presentation

import cz.semprec.app.android.feature.home.R
import cz.semprec.app.core.FailureKind
import org.junit.Assert.assertEquals
import org.junit.Test

class FailureMessageTest {
    @Test
    fun `every expected failure has its own message`() {
        val messages = FailureKind.entries.map(::failureMessage) + failureMessage(null)
        assertEquals(messages.size, messages.distinct().size)
    }

    @Test
    fun `unavailable content gets the unavailable message`() {
        assertEquals(R.string.failure_unavailable, failureMessage(FailureKind.UNAVAILABLE))
    }

    @Test
    fun `invalid data gets the invalid data message`() {
        assertEquals(R.string.failure_invalidData, failureMessage(FailureKind.INVALID_DATA))
    }

    @Test
    fun `an unexpected failure gets the generic message`() {
        assertEquals(R.string.failure_unexpected, failureMessage(null))
    }

    @Test
    fun `session and request failures get their own messages`() {
        assertEquals(R.string.failure_unauthorized, failureMessage(FailureKind.UNAUTHORIZED))
        assertEquals(R.string.failure_notFound, failureMessage(FailureKind.NOT_FOUND))
        assertEquals(R.string.failure_rejected, failureMessage(FailureKind.REJECTED))
    }
}
