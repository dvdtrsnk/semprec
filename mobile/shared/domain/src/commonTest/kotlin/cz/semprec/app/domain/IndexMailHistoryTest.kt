package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val INBOX = MailHistoryFolder("f1", "INBOX", uidvalidity = 7, backfillBelowUid = 3)

/** A server whose claims answer [claims] in turn (the last one repeats) and that takes every slice as the last. */
private class ClaimingServer(private val claims: List<RepositoryResult<MailHistoryClaim>>) : MailHistoryRepository {
    val claimTimes = mutableListOf<Long>()
    val tokens = mutableListOf<String?>()
    val slices = mutableListOf<MailHistorySlice>()
    val released = mutableListOf<String>()
    var clock: () -> Long = { 0 }

    override suspend fun claim(mailboxId: String, leaseToken: String?): RepositoryResult<MailHistoryClaim> {
        claimTimes += clock()
        tokens += leaseToken
        return claims[minOf(tokens.size - 1, claims.lastIndex)]
    }

    override suspend fun upload(
        mailboxId: String,
        slice: MailHistorySlice,
    ): RepositoryResult<MailHistoryUploadOutcome> {
        slices += slice
        return RepositoryResult.Content(MailHistoryUploadOutcome.Accepted(null))
    }

    override suspend fun release(mailboxId: String, leaseToken: String): RepositoryResult<Unit> {
        released += leaseToken
        return RepositoryResult.Content(Unit)
    }
}

/** An IMAP server whose folders hold UIDs 1 and 2 under UIDVALIDITY 7. */
private class TwoMessages : MailHistoryImap {
    var opened = 0

    override suspend fun open(login: MailHistoryLogin): RepositoryResult<MailHistoryImapSession> {
        opened += 1
        return RepositoryResult.Content(
            object : MailHistoryImapSession {
                override suspend fun examine(path: String) = RepositoryResult.Content(7L)

                override suspend fun search(low: Long, high: Long) =
                    RepositoryResult.Content(listOf(1L, 2L).filter { it in low..high })

                override suspend fun fetch(uids: List<Long>) =
                    RepositoryResult.Content(uids.associateWith { "* $it FETCH (UID $it)\r\n".encodeToByteArray() })

                override suspend fun close() = Unit
            },
        )
    }
}

private fun claim(vararg folders: MailHistoryFolder, pending: Boolean) =
    RepositoryResult.Content(MailHistoryClaim("lease", folders.toList(), pendingFullBackfill = pending))

private val LOGIN = MailHistoryLogin("imap.example.com", "me@example.com", "secret")

@OptIn(ExperimentalCoroutinesApi::class)
class IndexMailHistoryTest {
    private suspend fun TestScope.index(
        server: ClaimingServer,
        imap: TwoMessages = TwoMessages()
    ): MailHistoryIndexEnd {
        server.clock = { currentTime }
        return IndexMailHistory(server, imap, testScheduler.timeSource)("mb1", LOGIN) {}
    }

    @Test
    fun aClaimThatLeasesNothingWhileTheServerStillBackfillsIsRepeatedEvery30Seconds() = runTest {
        val server = ClaimingServer(listOf(claim(pending = true), claim(pending = true), claim(INBOX, pending = true)))

        assertEquals(MailHistoryIndexEnd.COMPLETE, index(server))

        assertEquals(listOf(0L, 30_000L, 60_000L), server.claimTimes)
        assertEquals(listOf(null, "lease", "lease"), server.tokens)
        assertEquals(listOf(2L, 1L), server.slices.single().messages.map { it.uid })
        assertEquals(listOf("lease"), server.released)
    }

    @Test
    fun theWaitForALeaseEndsAfter20Minutes() = runTest {
        val imap = TwoMessages()
        val server = ClaimingServer(listOf(claim(pending = true)))

        assertEquals(MailHistoryIndexEnd.NOTHING_LEASED, index(server, imap))

        assertEquals(20 * 60_000L, server.claimTimes.last())
        assertEquals(0, imap.opened)
        assertEquals(listOf("lease"), server.released)
    }

    @Test
    fun aClaimThatLeasesNothingWhileTheServerBackfillsNothingEndsAtOnce() = runTest {
        val server = ClaimingServer(listOf(claim(pending = false)))

        assertEquals(MailHistoryIndexEnd.NOTHING_LEASED, index(server))

        assertEquals(listOf(0L), server.claimTimes)
    }

    @Test
    fun aFailedClaimEndsTheRunWithoutOpeningTheImapServer() = runTest {
        val imap = TwoMessages()
        val first = ClaimingServer(listOf(RepositoryResult.Failure(FailureKind.REJECTED)))
        val later = ClaimingServer(listOf(claim(pending = true), RepositoryResult.Failure(FailureKind.UNAVAILABLE)))

        assertEquals(MailHistoryIndexEnd.SERVER_FAILED, index(first, imap))
        assertEquals(MailHistoryIndexEnd.SERVER_FAILED, index(later, imap))

        assertEquals(0, imap.opened)
        assertTrue(first.released.isEmpty())
        assertEquals(listOf("lease"), later.released)
    }
}
