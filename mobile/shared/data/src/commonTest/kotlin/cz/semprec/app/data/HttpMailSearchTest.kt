package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailRemoteSearch
import cz.semprec.app.domain.MailSearchResult
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

private const val SEARCH = """{"threads":[{"threadId":"t1","subject":"Faktura",
    "lastMessageAt":"2026-10-20T12:41:00.000Z",
    "lastSender":{"name":"Petr Novák","address":"petr@novak.cz"},"messageCount":2,"preview":"Posílám",
    "hasAttachment":true,"unread":false,"flagged":true,"mailboxes":[{"id":"m1","name":"Gmail"}],"hasSempDraft":false}],
    "localCount":7,"remote":{"searched":["m1","m2"],"failed":[{"mailboxId":"m2","reason":"providerUnreachable"}],
    "unindexed":12,"took":340}}"""

class HttpMailSearchTest {
    @Test
    fun aSearchSendsItsTextAndMailboxAndAnswersTheThreadsWithTheProviderSummary() = runTest {
        val server = MailTestServer { request ->
            if (request.url.encodedPath == "/api/mail/search") ok(SEARCH) else null
        }

        val answer = HttpMailContentRepository(server.api()).search("  faktura  ", "m1")
        val result = assertIs<RepositoryResult.Content<MailSearchResult>>(answer).value

        val sent = server.requests.single()
        assertEquals(HttpMethod.Get, sent.method)
        assertEquals("faktura", sent.query("q"))
        assertEquals("m1", sent.query("mailboxId"))
        assertEquals("50", sent.query("limit"))
        assertEquals(listOf("t1"), result.threads.map { it.threadId })
        assertEquals(listOf("Gmail"), result.threads.single().mailboxNames)
        assertEquals(MailRemoteSearch(listOf("m1", "m2"), listOf("m2"), 12), result.remote)
    }

    @Test
    fun aSearchOfEveryMailboxSendsNoMailboxAndAnAnswerWithoutAProviderPartHasNone() = runTest {
        val server = MailTestServer { ok("""{"threads":[],"localCount":0}""") }

        val answer = HttpMailContentRepository(server.api()).search("x", null)

        assertNull(server.requests.single().query("mailboxId"))
        assertEquals(
            RepositoryResult.Content(MailSearchResult(emptyList(), MailRemoteSearch(emptyList(), emptyList(), 0))),
            answer,
        )
    }

    @Test
    fun aFailedOrUnreadableSearchIsAFailureKind() = runTest {
        val cases = listOf(
            (HttpStatusCode.TooManyRequests to "{}") to FailureKind.UNAVAILABLE,
            (HttpStatusCode.BadRequest to "{}") to FailureKind.REJECTED,
            ok("""{"threads":[{"subject":1}]}""") to FailureKind.INVALID_DATA,
        )
        for ((response, kind) in cases) {
            val answer = HttpMailContentRepository(MailTestServer { response }.api()).search("x", null)
            assertEquals(RepositoryResult.Failure(kind), answer, "${response.first}")
        }
    }
}
