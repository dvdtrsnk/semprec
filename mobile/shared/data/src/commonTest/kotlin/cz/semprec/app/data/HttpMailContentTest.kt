package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailContentUnavailable
import cz.semprec.app.domain.MailContentOutcome
import cz.semprec.app.domain.MailContentState
import cz.semprec.app.domain.MailMessageContent
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val EMAIL = "22222222-2222-4222-8222-222222222222"
private const val ATTACHMENT = "33333333-3333-4333-8333-333333333333"

private fun message(id: String, state: String, body: String, preview: String?, attachments: String = "") =
    """{"emailId":"$id","messageId":"<$id@x>","mailboxId":"m1","folderPurpose":"inbox","isOwn":false,
    "from":{"name":"Petr","address":"petr@novak.cz"},"to":[],"cc":[],"replyTo":[],"date":"2026-01-02T10:00:00.000000Z",
    "bodyHtml":"<p>$body</p>","bodyText":"$body","contentState":"$state",
    "preview":${preview?.let { "\"$it\"" } ?: "null"},"read":true,"flagged":false,"futureField":{"x":1},
    "attachments":[$attachments]}"""

private fun detail(vararg messages: String) =
    """{"threadId":"t1","subject":"S","lastSender":{"name":"Petr","address":"petr@novak.cz"},"messageCount":3,
    "unread":false,"flagged":false,"mailboxes":[],"links":{},"tasks":[],"somethingNew":true,
    "messages":[${messages.joinToString(",")}]}"""

private const val UNSTORED = """{"attachmentId":"$ATTACHMENT","stored":false,"blobId":null,"fileItemId":null,
    "filename":"smlouva.pdf","contentType":"application/pdf","byteSize":12000,"project":null,"links":{},
    "partHint":"2"}"""

private const val CONTENT = """{"emailId":"$EMAIL","contentState":"cached","bodyHtml":"<p>Celý text</p>",
    "bodyText":"Celý text","fetchedAt":"2026-11-20T10:00:00.000Z","expiresAt":"2026-11-27T10:00:00.000Z",
    "attachments":[$UNSTORED],"servedBy":"imap"}"""

private fun unavailable(reason: String) =
    HttpStatusCode.Conflict to
        """{"error":{"code":"mail_content_unavailable","message":"x","details":{"reason":"$reason"}}}"""

private typealias FetchFailure = Pair<Pair<HttpStatusCode, String>, RepositoryResult<MailContentOutcome<Nothing>>>

/** The failures a read or a save that asks the provider can answer, with what the repository makes of them. */
private val FETCH_FAILURES: List<FetchFailure> =
    listOf(
        unavailable("reauthorizationRequired") to
            RepositoryResult.Content(MailContentOutcome.Unavailable(MailContentUnavailable.REAUTHORIZATION_REQUIRED)),
        unavailable("providerUnreachable") to
            RepositoryResult.Content(MailContentOutcome.Unavailable(MailContentUnavailable.PROVIDER_UNREACHABLE)),
        unavailable("messageNotFound") to
            RepositoryResult.Content(MailContentOutcome.Unavailable(MailContentUnavailable.MESSAGE_NOT_FOUND)),
        unavailable("mailboxUnavailable") to
            RepositoryResult.Content(MailContentOutcome.Unavailable(MailContentUnavailable.MAILBOX_UNAVAILABLE)),
        unavailable("attachmentTooLarge") to
            RepositoryResult.Content(MailContentOutcome.Unavailable(MailContentUnavailable.ATTACHMENT_TOO_LARGE)),
        (HttpStatusCode.TooManyRequests to """{"error":{"code":"rate_limited"}}""") to
            RepositoryResult.Content(MailContentOutcome.Unavailable(MailContentUnavailable.RATE_LIMITED)),
        unavailable("somethingElse") to RepositoryResult.Failure(FailureKind.REJECTED),
        (HttpStatusCode.Conflict to """{"error":{"code":"version_conflict"}}""") to
            RepositoryResult.Failure(FailureKind.REJECTED),
        (HttpStatusCode.Conflict to "<html>") to RepositoryResult.Failure(FailureKind.REJECTED),
        (HttpStatusCode.NotFound to """{"error":{"code":"not_found"}}""") to
            RepositoryResult.Failure(FailureKind.NOT_FOUND),
        (HttpStatusCode.ServiceUnavailable to "{}") to RepositoryResult.Failure(FailureKind.UNAVAILABLE),
        (HttpStatusCode.Unauthorized to "{}") to RepositoryResult.Failure(FailureKind.UNAUTHORIZED),
    )

class HttpMailContentTest {
    private fun server(handler: (HttpRequestData) -> Pair<HttpStatusCode, String>?) = MailTestServer(handler)

    private fun MailTestServer.mail() = HttpMailContentRepository(api())

    private fun MailTestServer.threads() = HttpMailRepository(api())

    @Test
    fun aThreadTellsWhereEachBodyIsAndKeepsThePreviewOfARemoteOne() = runTest {
        val answer = server {
            ok(
                detail(
                    message("e1", "full", "Plný", "Plný"),
                    message("e2", "cached", "Z mezipaměti", "Z mez"),
                    message("e3", "remote", "", "Jen náhled", attachments = UNSTORED),
                ),
            )
        }.threads().thread("t1")
        val messages = assertIs<RepositoryResult.Content<MailThreadDetail>>(answer).value.messages

        assertEquals(
            listOf(MailContentState.FULL, MailContentState.CACHED, MailContentState.REMOTE),
            messages.map { it.contentState },
        )
        assertEquals(listOf("Plný", "Z mezipaměti", ""), messages.map { it.bodyText })
        assertEquals("Jen náhled", messages.last().preview)
        val file = messages.last().attachments.single()
        assertEquals(ATTACHMENT, file.attachmentId)
        assertFalse(file.stored)
        assertNull(file.blobId)
        assertNull(file.fileItemId)
        assertEquals(12000, file.byteSize)
    }

    @Test
    fun aMessageWithoutAPreviewOrWithAnUnknownContentState() = runTest {
        val withoutPreview = server { ok(detail(message("e1", "full", "Text", null))) }.threads().thread("t1")
        val unknown = server { ok(detail(message("e1", "elsewhere", "", null))) }.threads().thread("t1")

        val message = assertIs<RepositoryResult.Content<MailThreadDetail>>(withoutPreview).value.messages.single()
        assertNull(message.preview)
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), unknown)
    }

    @Test
    fun theContentOfAMessageIsReadFromItsRoute() = runTest {
        val server = server { request ->
            if (request.url.encodedPath == "/api/mail/messages/$EMAIL/content") ok(CONTENT) else null
        }

        val answer = server.mail().messageContent(EMAIL)

        assertEquals(
            RepositoryResult.Content(MailContentOutcome.Done(MailMessageContent(EMAIL, "Celý text"))),
            answer,
        )
        assertEquals(HttpMethod.Get, server.requests.single().method)
    }

    @Test
    fun aContentReadThatTheProviderCouldNotServeSaysWhy() = runTest {
        for ((response, expected) in FETCH_FAILURES) {
            assertEquals(expected, server { response }.mail().messageContent(EMAIL), response.second)
        }
        assertEquals(
            RepositoryResult.Failure(FailureKind.INVALID_DATA),
            server { ok("""{"bodyText":"no id"}""") }.mail().messageContent(EMAIL),
        )
    }

    @Test
    fun savingAnAttachmentPostsToItsRouteAndAnswersTheFilesItem() = runTest {
        val path = "/api/mail/messages/$EMAIL/attachments/$ATTACHMENT/save"
        val server = server { request ->
            if (request.url.encodedPath == path) ok("""{"fileItemId":"f9","extra":1}""") else null
        }

        val answer = server.mail().saveAttachment(EMAIL, ATTACHMENT)

        assertEquals(RepositoryResult.Content(MailContentOutcome.Done("f9")), answer)
        assertEquals(HttpMethod.Post, server.requests.single().method)
        assertEquals(listOf("{}"), server.bodies)
    }

    @Test
    fun aSaveThatTheProviderCouldNotServeSaysWhy() = runTest {
        for ((response, expected) in FETCH_FAILURES) {
            assertEquals(expected, server { response }.mail().saveAttachment(EMAIL, ATTACHMENT), response.second)
        }
    }

    @Test
    fun theIdsOfAMessageAndAnAttachmentAreEncodedIntoThePath() = runTest {
        val server = server { ok("""{"fileItemId":"f9"}""") }

        server.mail().saveAttachment("a/b", "c d")

        assertTrue(server.requests.single().url.encodedPath.endsWith("/messages/a%2Fb/attachments/c%20d/save"))
    }
}
