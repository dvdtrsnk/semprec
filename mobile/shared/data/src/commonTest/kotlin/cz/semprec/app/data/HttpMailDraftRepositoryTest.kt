package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailRefusal
import cz.semprec.app.domain.MailAddress
import cz.semprec.app.domain.MailContact
import cz.semprec.app.domain.MailDraft
import cz.semprec.app.domain.MailDraftFields
import cz.semprec.app.domain.MailDraftMode
import cz.semprec.app.domain.MailOutcome
import cz.semprec.app.domain.MailPrefill
import cz.semprec.app.domain.MailSentDraft
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

private const val DRAFT_JSON = """{"id":"$DRAFT","mailboxId":"m1","from":"me@x.cz",
    "to":[{"name":"Petr","address":"petr@novak.cz"}],"cc":[],"bcc":[],"subject":"Re: Nabídka","body":"Ahoj",
    "threadId":"t1","mode":"replyAll","sourceEmailId":"e1","attachments":[],"createdBy":"agent",
    "lastEditedBy":"agent","updatedAt":"2026-10-20T12:00:00.000Z","version":"6","sentAt":null}"""

private const val SENT_JSON = """{"emailId":"$DRAFT","threadId":"t1","sentAt":"2026-10-20T12:05:00Z",
    "mailbox":{"id":"m1","name":"Gmail"}}"""

private val PREFILL = MailPrefill("m1", MailDraftMode.REPLY, "e1", body = "")

private val FIELDS = MailDraftFields(
    mailboxId = "m1",
    from = "me@x.cz",
    to = listOf(MailAddress("Petr", "petr@novak.cz")),
    cc = emptyList(),
    bcc = listOf(MailAddress("", "hidden@x.cz")),
    subject = "Nabídka",
    body = "Text",
)

class HttpMailDraftRepositoryTest {
    private fun MailTestServer.drafts() = HttpMailDraftRepository(api())

    private fun routes(request: io.ktor.client.request.HttpRequestData): Pair<HttpStatusCode, String>? =
        when {
            request.url.encodedPath == "/api/mail/drafts" && request.method == HttpMethod.Post ->
                HttpStatusCode.Created to DRAFT_JSON
            request.url.encodedPath == "/api/mail/drafts/$DRAFT/send" ->
                ok(SENT_JSON)
            request.url.encodedPath == "/api/mail/drafts/$DRAFT" && request.method == HttpMethod.Delete ->
                ok("""{"id":"$DRAFT"}""")
            request.url.encodedPath == "/api/mail/drafts/$DRAFT" -> ok(DRAFT_JSON)
            request.url.encodedPath == "/api/mail/contacts" ->
                ok(
                    """{"contacts":[{"personId":"p1","name":"Petr Novák","email":"petr@novak.cz","relationship":"Klient"},
                    {"personId":"p2","name":"","email":"anon@x.cz","relationship":null}]}"""
                )
            else -> null
        }

    private fun JsonObject.firstAddress(key: String) =
        getValue(key).jsonArray.single().jsonObject.getValue("address").jsonPrimitive.content

    private fun sentBody(server: MailTestServer): JsonObject = Json.parseToJsonElement(server.bodies.last()).jsonObject

    @Test
    fun aNewDraftSendsEveryFieldInModeNewWithItsThread() = runTest {
        val server = MailTestServer(::routes)

        val answer = server.drafts().create(FIELDS, threadId = "t1")

        val body = sentBody(server)
        assertEquals("new", body.getValue("mode").jsonPrimitive.content)
        assertEquals("t1", body.getValue("threadId").jsonPrimitive.content)
        assertEquals("m1", body.getValue("mailboxId").jsonPrimitive.content)
        assertEquals("me@x.cz", body.getValue("from").jsonPrimitive.content)
        assertEquals("Nabídka", body.getValue("subject").jsonPrimitive.content)
        assertEquals("petr@novak.cz", body.firstAddress("to"))
        assertEquals("hidden@x.cz", body.firstAddress("bcc"))
        assertTrue(answer is RepositoryResult.Content)
    }

    @Test
    fun aDraftWithoutAThreadSendsNone() = runTest {
        val server = MailTestServer(::routes)

        server.drafts().create(FIELDS, threadId = null)

        assertFalse(sentBody(server).containsKey("threadId"))
    }

    @Test
    fun aPrefilledDraftSendsOnlyTheSourceAndTheModeAndTheServerWritesTheRest() = runTest {
        val server = MailTestServer(::routes)

        server.drafts().createPrefilled(MailPrefill("m1", MailDraftMode.FORWARD, "e1", body = ""))

        val body = sentBody(server)
        assertEquals(setOf("mailboxId", "mode", "sourceEmailId", "body"), body.keys)
        assertEquals("forward", body.getValue("mode").jsonPrimitive.content)
        assertEquals("e1", body.getValue("sourceEmailId").jsonPrimitive.content)
    }

    @Test
    fun aDraftIsReadWithItsAuthorAndVersion() = runTest {
        val server = MailTestServer(::routes)

        val draft = assertIs<RepositoryResult.Content<MailDraft>>(server.drafts().read(DRAFT)).value

        assertTrue(draft.createdByAgent)
        assertEquals(MailDraftMode.REPLY_ALL, draft.mode)
        assertEquals("6", draft.version)
        assertEquals("t1", draft.threadId)
        assertEquals(MailAddress("Petr", "petr@novak.cz"), draft.to.single())
    }

    @Test
    fun anUpdateCarriesTheVersionItReplaces() = runTest {
        val server = MailTestServer(::routes)

        server.drafts().update(DRAFT, "v1", FIELDS)

        assertEquals(HttpMethod.Patch, server.requests.single().method)
        assertEquals("v1", sentBody(server).getValue("ifVersion").jsonPrimitive.content)
    }

    @Test
    fun theVersionADraftIsReadWithIsWhatItsUpdateSends() = runTest {
        val server = MailTestServer(::routes)
        val drafts = server.drafts()
        val draft = assertIs<RepositoryResult.Content<MailDraft>>(drafts.read(DRAFT)).value

        drafts.update(draft.id, draft.version, FIELDS)

        assertEquals(HttpMethod.Patch, server.requests.last().method)
        assertEquals("6", sentBody(server).getValue("ifVersion").jsonPrimitive.content)
    }

    @Test
    fun aStaleUpdateIsARejection() = runTest {
        val server = MailTestServer { HttpStatusCode.Conflict to "{}" }

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), server.drafts().update(DRAFT, "old", FIELDS))
    }

    @Test
    fun sendingAnswersWhereTheMessageWentAndDiscardingDeletes() = runTest {
        val server = MailTestServer(::routes)
        val drafts = server.drafts()

        val sent = drafts.send(DRAFT)
        val discarded = drafts.discard(DRAFT)

        assertEquals(RepositoryResult.Content(MailOutcome.Done(MailSentDraft(DRAFT, "t1", "Gmail"))), sent)
        assertEquals(RepositoryResult.Content(Unit), discarded)
        assertEquals(listOf(HttpMethod.Post, HttpMethod.Delete), server.requests.map { it.method })
    }

    @Test
    fun aSendTheServerRefusesIsARejectionAndAnUnknownDraftNotFound() = runTest {
        val refused = MailTestServer { HttpStatusCode.UnprocessableEntity to "{}" }
        val missing = MailTestServer { HttpStatusCode.NotFound to "{}" }

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refused.drafts().send(DRAFT))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), missing.drafts().read(DRAFT))
    }

    @Test
    fun aDraftWriteOrSendRefusedWithAKnownCodeAnswersItsRefusal() = runTest {
        val cases = listOf<Triple<String, suspend HttpMailDraftRepository.() -> Any, MailRefusal>>(
            Triple("mail_drafts_folder_missing", { create(FIELDS, null) }, MailRefusal.DRAFTS_FOLDER_MISSING),
            Triple("mail_drafts_folder_missing", { createPrefilled(PREFILL) }, MailRefusal.DRAFTS_FOLDER_MISSING),
            Triple("mail_attachment_too_large", { createPrefilled(PREFILL) }, MailRefusal.ATTACHMENT_TOO_LARGE),
            Triple("mail_draft_already_sent", { update(DRAFT, "6", FIELDS) }, MailRefusal.DRAFT_ALREADY_SENT),
            Triple("mail_draft_not_editable", { update(DRAFT, "6", FIELDS) }, MailRefusal.DRAFT_NOT_EDITABLE),
            Triple("mail_sent_folder_missing", { send(DRAFT) }, MailRefusal.SENT_FOLDER_MISSING),
            Triple("mail_reauthorization_required", { send(DRAFT) }, MailRefusal.REAUTHORIZATION_REQUIRED),
            Triple("mail_disabled", { send(DRAFT) }, MailRefusal.MAIL_DISABLED),
            Triple("mail_recipient_rejected", { send(DRAFT) }, MailRefusal.RECIPIENT_REJECTED),
            Triple("mail_auth_failed", { send(DRAFT) }, MailRefusal.LOGIN_REJECTED),
            Triple("mail_server_unreachable", { send(DRAFT) }, MailRefusal.SERVER_UNREACHABLE),
        )
        for ((code, call, refusal) in cases) {
            val server = MailTestServer {
                HttpStatusCode.Conflict to """{"error":{"code":"$code","message":"x","details":{"mailboxId":"m1"}}}"""
            }

            assertEquals(RepositoryResult.Content(MailOutcome.Refused(refusal)), server.drafts().call(), code)
        }
    }

    @Test
    fun aRefusalCodeAtTheTopLevelIsReadToo() = runTest {
        val server = MailTestServer { HttpStatusCode.Conflict to """{"code":"mail_drafts_folder_missing"}""" }

        assertEquals(
            RepositoryResult.Content(MailOutcome.Refused(MailRefusal.DRAFTS_FOLDER_MISSING)),
            server.drafts().create(FIELDS, threadId = null),
        )
    }

    @Test
    fun anUnknownCodeOrAnErrorWithoutABodyStaysItsFailure() = runTest {
        val unknown = MailTestServer { HttpStatusCode.Conflict to """{"error":{"code":"mail_agent_draft_exists"}}""" }
        val empty = MailTestServer { HttpStatusCode.ServiceUnavailable to "" }

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), unknown.drafts().send(DRAFT))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), empty.drafts().create(FIELDS, threadId = null))
    }

    @Test
    fun aDraftWithAnUnknownModeIsUnreadable() = runTest {
        val server = MailTestServer { ok(DRAFT_JSON.replace("replyAll", "teleport")) }

        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), server.drafts().read(DRAFT))
    }

    @Test
    fun contactsAreSearchedWithTheAddressesAlreadyChosenLeftOut() = runTest {
        val server = MailTestServer(::routes)

        val answer = server.drafts().contacts(" pet ", listOf("a@x.cz", "b@x.cz"))

        val sent = server.requests.single()
        assertEquals("pet", sent.query("q"))
        assertEquals("a@x.cz,b@x.cz", sent.query("exclude"))
        assertEquals(
            RepositoryResult.Content(
                listOf(MailContact("Petr Novák", "petr@novak.cz", "Klient"), MailContact("", "anon@x.cz", null)),
            ),
            answer,
        )
    }

    @Test
    fun contactsWithoutExclusionsSendNoExcludeParameter() = runTest {
        val server = MailTestServer(::routes)

        server.drafts().contacts("a", emptyList())

        assertNull(server.requests.single().query("exclude"))
    }
}
