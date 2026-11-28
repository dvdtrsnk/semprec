package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailRefusal
import cz.semprec.app.core.MailRefusal.NO_RECEIVED_MESSAGE
import cz.semprec.app.domain.MailBox
import cz.semprec.app.domain.MailFacetOption
import cz.semprec.app.domain.MailFacets
import cz.semprec.app.domain.MailLinkBreaker
import cz.semprec.app.domain.MailLinkKind
import cz.semprec.app.domain.MailNamedRef
import cz.semprec.app.domain.MailOutcome
import cz.semprec.app.domain.MailSummary
import cz.semprec.app.domain.MailThreadChanges
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.MailThreadPage
import cz.semprec.app.domain.MailThreadQuery
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val THREAD = "11111111-1111-4111-8111-111111111111"
private const val PROJECTS_DB = "aaaaaaaa-0000-4000-8000-00000000000b"

private const val THREADS = """{"threads":[{"threadId":"$THREAD","subject":"Re: Nabídka","lastMessageAt":"2026-10-20T12:41:00.000000Z",
    "lastSender":{"name":"Petr Novák","address":"petr@novak.cz","personId":null},"participants":[],"messageCount":4,
    "preview":"Díky","hasAttachment":true,"unread":true,"flagged":false,
    "mailboxes":[{"id":"m1","name":"Gmail","provider":"gmail"}],
    "senderPerson":{"id":"p1","name":"Petr","relationship":"Klient"},
    "project":{"id":"pr1","name":"Web"},"company":{"id":"c1","name":"Novák Web"},"hasSempDraft":true,"links":{}}],
    "nextCursor":"abc"}"""

private const val FACETS = """{"total":9,
    "projects":{"total":7,"items":[{"id":"pr1","count":3},{"id":"nameless","count":2},{"id":"gone","count":1}]}}"""

private const val PROJECTS = """{"items":[
    {"id":"pr1","databaseId":"$PROJECTS_DB","properties":{"name":"Web","color":"#FF9500"}},
    {"id":"nameless","databaseId":"$PROJECTS_DB","properties":{}},
    {"id":"quiet","databaseId":"$PROJECTS_DB","properties":{"name":"Zahrada"}}]}"""

private const val DATABASES = """{"databases":[{"id":"$PROJECTS_DB","key":"projects","name":"Projects"}]}"""

private const val SUMMARY = """{"unreadInbox":5,"flagged":2,"sempDrafts":1,"accounts":2,
    "accountsNeedingReauth":[{"id":"m1","name":"Gmail"}]}"""

private const val DETAIL = """{"threadId":"$THREAD","subject":"Re: Nabídka","lastMessageAt":"2026-10-20T12:41:00.000000Z",
    "lastSender":{"name":"Petr Novák","address":"petr@novak.cz"},"participants":[],"messageCount":2,"unread":true,
    "flagged":true,"mailboxes":[{"id":"m1","name":"Gmail","provider":"gmail"}],
    "senderPerson":{"id":"p1","name":"Petr","relationship":"Klient"},
    "project":{"id":"pr1","name":"Web"},"company":{"id":"c1","name":"Novák Web"},
    "links":{"company":{"valueKind":"inherited","sources":[{"kind":"item","itemId":"p1","title":"Petr Novák"}]},
      "project":{"valueKind":"inheritedBroken","sources":[],"brokenBy":"agent"}},
    "messages":[
      {"emailId":"e1","messageId":"m-1","mailboxId":"m1","folderPurpose":"inbox","isOwn":false,
       "from":{"name":"Petr Novák","address":"petr@novak.cz"},"to":[{"name":"","address":"me@x.cz"}],"cc":[],"replyTo":[],
       "date":"2026-10-20T12:41:00.000000Z","read":false,"flagged":false,"bodyHtml":"<p>Ahoj</p>","bodyText":"Ahoj",
       "contentState":"full","preview":"Ahoj",
       "attachments":[{"attachmentId":"a1","stored":true,"fileItemId":"f1","blobId":"b1","filename":"nabidka.pdf",
         "contentType":"application/pdf","byteSize":840,"project":{"id":"pr1","name":"Web"},
         "links":{"project":{"valueKind":"derived","sources":[]}}}]},
      {"emailId":"e2","messageId":"m-2","mailboxId":"m1","folderPurpose":"drafts","isOwn":true,"from":null,
       "to":[],"cc":[],"replyTo":[],"date":null,"read":true,"flagged":false,"bodyHtml":"","bodyText":"",
       "contentState":"full","preview":null,"attachments":[]}],
    "tasks":[{"id":"t1","name":"Poslat nabídku","date":"2026-10-23","status":"notDone",
       "project":{"id":"pr1","state":"trashed"},
       "people":[{"id":"pp1","state":"active","name":"Petr"},{"id":"pp2","state":"trashed"}],
       "links":{"project":{"valueKind":"surprise","sources":[]}}}]}"""

class HttpMailRepositoryTest {
    private fun MailTestServer.mail() = HttpMailRepository(api())

    private fun server(handler: (HttpRequestData) -> Pair<HttpStatusCode, String>?) = MailTestServer(handler)

    private fun routes(request: HttpRequestData): Pair<HttpStatusCode, String>? = when (request.url.encodedPath) {
        "/api/mail/threads" -> ok(THREADS)
        "/api/mail/threads/facets" -> ok(FACETS)
        "/api/databases" -> ok(DATABASES)
        "/api/databases/$PROJECTS_DB/query" -> ok(PROJECTS)
        "/api/mail/summary" ->
            ok(SUMMARY)
        "/api/mail/threads/$THREAD" -> ok(DETAIL)
        "/api/mail/threads/$THREAD/read" -> ok("""{"threadId":"$THREAD","unread":false}""")
        "/api/mail/threads/$THREAD/flag" -> ok("""{"threadId":"$THREAD","flagged":true}""")
        "/api/mail/threads/$THREAD/archive",
        "/api/mail/threads/$THREAD/trash",
        "/api/mail/threads/$THREAD/restore",
        -> ok("""{"threadId":"$THREAD","moved":1}""")
        "/api/mail/threads/$THREAD/tasks" -> HttpStatusCode.Created to """{"id":"t9","name":"Zavolat","date":null}"""
        else -> null
    }

    @Test
    fun theListSendsItsFiltersAndMapsTheThreads() = runTest {
        val server = server(::routes)
        val query = MailThreadQuery(
            box = MailBox.FLAGGED,
            mailboxId = "m1",
            folderId = "f1",
            projectId = "pr1",
            unreadOnly = true,
            search = "  from:petr  ",
            cursor = "c0",
        )

        val answer = server.mail().threads(query)
        val page = assertIs<RepositoryResult.Content<MailThreadPage>>(answer).value

        val sent = server.requests.single()
        assertEquals(HttpMethod.Get, sent.method)
        val expected = mapOf(
            "box" to "flagged", "limit" to "50", "mailboxId" to "m1", "folderId" to "f1",
            "projectId" to "pr1", "unread" to "true", "q" to "from:petr", "cursor" to "c0",
        )
        expected.forEach { (name, value) -> assertEquals(value, sent.query(name), name) }
        assertEquals("abc", page.nextCursor)
        val thread = page.threads.single()
        assertEquals(THREAD, thread.threadId)
        assertEquals("Petr Novák", thread.senderName)
        assertEquals("Klient", thread.senderRelationship)
        assertEquals(listOf("Gmail"), thread.mailboxNames)
        assertEquals(MailNamedRef("pr1", "Web"), thread.project)
        assertEquals("Novák Web", thread.company?.name)
        assertTrue(thread.unread && thread.hasAttachment && thread.hasSempDraft && !thread.flagged)
    }

    @Test
    fun theListReadsTheChangesCursorOfItsPage() = runTest {
        val server =
            server { ok(THREADS.replace("\"nextCursor\":\"abc\"", "\"nextCursor\":null,\"changesCursor\":\"k1\"")) }

        val page = assertIs<RepositoryResult.Content<MailThreadPage>>(server.mail().threads(MailThreadQuery())).value

        assertEquals("k1", page.changesCursor)
        assertNull(page.nextCursor)
    }

    @Test
    fun theChangesSendTheViewAndTheCursorAndMapTheRowsAndTheRemovedIds() = runTest {
        val server = server { request ->
            if (request.url.encodedPath != "/api/mail/threads/changes") return@server null
            ok(
                THREADS.replace("\"nextCursor\":\"abc\"", "\"cursor\":\"k2\",\"removed\":[\"gone\"],\"reset\":false"),
            )
        }
        val query = MailThreadQuery(
            box = MailBox.SEMP_DRAFTS,
            mailboxId = "m1",
            folderId = "f1",
            projectId = "pr1",
            unreadOnly = true,
            search = "ignored",
            cursor = "ignored",
        )

        val answer = server.mail().threadChanges(query, "k1")

        val changes = assertIs<RepositoryResult.Content<MailThreadChanges>>(answer).value
        val sent = server.requests.single()
        assertEquals(HttpMethod.Get, sent.method)
        val expected = mapOf(
            "box" to "sempDrafts", "mailboxId" to "m1", "folderId" to "f1", "projectId" to "pr1",
            "unread" to "true", "since" to "k1",
        )
        assertEquals(expected, sent.url.parameters.names().associateWith { sent.query(it).orEmpty() })
        assertEquals(MailThreadChanges("k2", changes.threads, listOf("gone"), reset = false), changes)
        assertEquals(THREAD, changes.threads.single().threadId)
    }

    @Test
    fun aResetOfTheChangesCarriesOnlyTheNewCursor() = runTest {
        val server = server { ok("""{"cursor":"k3","threads":[],"removed":[],"reset":true}""") }

        val answer = server.mail().threadChanges(MailThreadQuery(), "old")

        assertEquals(
            RepositoryResult.Content(MailThreadChanges("k3", emptyList(), emptyList(), reset = true)),
            answer,
        )
        assertEquals(
            mapOf("box" to "inbox", "since" to "old"),
            server.requests.single().let { sent ->
                sent.url.parameters.names().associateWith { sent.query(it).orEmpty() }
            }
        )
    }

    @Test
    fun theDefaultListAsksForTheInboxWithoutFilters() = runTest {
        val server = server(::routes)

        server.mail().threads(MailThreadQuery())

        val sent = server.requests.single()
        assertEquals("inbox", sent.query("box"))
        listOf("mailboxId", "folderId", "projectId", "unread", "q", "cursor").forEach {
            assertNull(sent.query(it), it)
        }
    }

    @Test
    fun aFailedOrUnreadableListIsAFailureKind() = runTest {
        val failing = server { HttpStatusCode.ServiceUnavailable to "{}" }
        val unauthorized = server { HttpStatusCode.Unauthorized to "{}" }
        val garbled = server { ok("""{"threads":[{"subject":1}]}""") }

        assertEquals(
            RepositoryResult.Failure(FailureKind.UNAVAILABLE),
            failing.mail().threads(MailThreadQuery()),
        )
        assertEquals(
            RepositoryResult.Failure(FailureKind.UNAUTHORIZED),
            unauthorized.mail().threads(MailThreadQuery()),
        )
        assertEquals(
            RepositoryResult.Failure(FailureKind.INVALID_DATA),
            garbled.mail().threads(MailThreadQuery()),
        )
    }

    @Test
    fun theFacetsAskWithoutParametersAndGetTheirNamesFromTheItemsDroppingWhatHasNone() = runTest {
        val server = server(::routes)

        val answer = server.mail().facets()
        val facets = assertIs<RepositoryResult.Content<MailFacets>>(answer).value

        val sent = server.requests.first { it.url.encodedPath == "/api/mail/threads/facets" }
        assertTrue(sent.url.parameters.isEmpty())
        assertEquals(MailFacets(9, 7, listOf(MailFacetOption("pr1", "Web", "#FF9500", 3))), facets)
        assertEquals(
            listOf("/api/mail/threads/facets", "/api/databases", "/api/databases/$PROJECTS_DB/query"),
            server.requests.map { it.url.encodedPath },
        )
    }

    @Test
    fun aProjectIsNamedFromTheProjectsWithoutAskingTheFacets() = runTest {
        val expected = mapOf("pr1" to "Web", "quiet" to "Zahrada", "nameless" to null, "gone" to null)
        for ((projectId, name) in expected) {
            val server = server(::routes)

            assertEquals(RepositoryResult.Content(name), server.mail().projectName(projectId), projectId)
            assertEquals(
                listOf("/api/databases", "/api/databases/$PROJECTS_DB/query"),
                server.requests.map { it.url.encodedPath },
            )
        }
    }

    @Test
    fun theSummaryCountsAndNamesTheMailboxesThatNeedASignIn() = runTest {
        val answer = server(::routes).mail().summary()
        val summary = assertIs<RepositoryResult.Content<MailSummary>>(answer).value

        assertEquals(MailSummary(5, 2, 1, 2, listOf(MailNamedRef("m1", "Gmail"))), summary)
    }

    @Test
    fun aThreadMapsMessagesTasksAndTheStateOfEveryLink() = runTest {
        val answer = server(::routes).mail().thread(THREAD)
        val detail = assertIs<RepositoryResult.Content<MailThreadDetail>>(answer).value

        assertEquals("Petr Novák", detail.senderName)
        assertEquals(MailLinkKind.INHERITED, detail.companyLink?.kind)
        assertEquals(listOf("Petr Novák"), detail.companyLink?.sourceTitles)
        assertEquals(MailLinkKind.BROKEN, detail.projectLink?.kind)
        assertEquals(MailLinkBreaker.AGENT, detail.projectLink?.brokenBy)
        assertEquals(listOf("inbox", "drafts"), detail.messages.map { it.folderPurpose })
        val first = detail.messages.first()
        assertEquals("Ahoj", first.bodyText)
        assertEquals("me@x.cz", first.to.single().address)
        val file = first.attachments.single()
        assertEquals("nabidka.pdf", file.filename)
        assertEquals("Web", file.project?.name)
        assertEquals(Triple("a1", "b1", "f1"), Triple(file.attachmentId, file.blobId, file.fileItemId))
        assertTrue(file.stored)
        assertEquals(MailLinkKind.DERIVED, file.projectLink?.kind)
        assertNull(detail.messages.last().from)
        val task = detail.tasks.single()
        assertEquals("notDone", task.status)
        assertNull(task.projectName)
        assertEquals(listOf("Petr"), task.peopleNames)
        assertNull(task.projectLink)
    }

    @Test
    fun readAndFlagSendTheirValueAndAnswerTheServersState() = runTest {
        val server = server(::routes)

        val mail = server.mail()
        val unread = mail.setRead(THREAD, read = true)
        val flagged = mail.setFlagged(THREAD, flagged = true)

        assertEquals(RepositoryResult.Content(MailOutcome.Done(false)), unread)
        assertEquals(RepositoryResult.Content(MailOutcome.Done(true)), flagged)
        assertEquals(listOf("""{"read":true}""", """{"flagged":true}"""), server.bodies)
        assertTrue(server.requests.all { it.method == HttpMethod.Post })
    }

    @Test
    fun movesAndTasksPostToTheirThreadRoute() = runTest {
        val server = server(::routes)
        val mail = server.mail()

        assertEquals(RepositoryResult.Content(MailOutcome.Done(Unit)), mail.archive(THREAD))
        assertEquals(RepositoryResult.Content(MailOutcome.Done(Unit)), mail.trash(THREAD))
        assertEquals(RepositoryResult.Content(MailOutcome.Done(Unit)), mail.restore(THREAD))
        val task = mail.createTask(THREAD)

        assertEquals(
            listOf("archive", "trash", "restore", "tasks"),
            server.requests.map { it.url.encodedPath.substringAfterLast('/') },
        )
        assertEquals(RepositoryResult.Content(MailNamedRef("t9", "Zavolat")), task)
    }

    @Test
    fun aThreadActionRefusedWithAKnownCodeAnswersItsRefusal() = runTest {
        val cases = listOf<Triple<String, suspend HttpMailRepository.() -> Any, MailRefusal>>(
            Triple("mail_thread_no_received_message", { setRead(THREAD, read = false) }, NO_RECEIVED_MESSAGE),
            Triple("mail_thread_no_received_message", { setFlagged(THREAD, flagged = true) }, NO_RECEIVED_MESSAGE),
            Triple("mail_archive_folder_missing", { archive(THREAD) }, MailRefusal.ARCHIVE_FOLDER_MISSING),
            Triple("mail_move_source_unverified", { archive(THREAD) }, MailRefusal.MOVE_SOURCE_UNVERIFIED),
            Triple("mail_trash_folder_missing", { trash(THREAD) }, MailRefusal.TRASH_FOLDER_MISSING),
            Triple("mail_thread_already_trashed", { trash(THREAD) }, MailRefusal.ALREADY_TRASHED),
            Triple("mail_inbox_folder_missing", { restore(THREAD) }, MailRefusal.INBOX_FOLDER_MISSING),
            Triple("mail_sent_folder_missing", { restore(THREAD) }, MailRefusal.SENT_FOLDER_MISSING),
            Triple("mail_thread_not_archived_or_trashed", { restore(THREAD) }, MailRefusal.NOT_ARCHIVED_OR_TRASHED),
        )
        for ((code, call, refusal) in cases) {
            val server = server {
                HttpStatusCode.Conflict to """{"error":{"code":"$code","message":"x","details":{"mailboxId":"m1"}}}"""
            }

            assertEquals(RepositoryResult.Content(MailOutcome.Refused(refusal)), server.mail().call(), code)
        }
    }

    @Test
    fun aMoveRefusedWithAnUnknownCodeOrAnUnreadableBodyIsARejection() = runTest {
        val unknown = server { HttpStatusCode.Conflict to """{"error":{"code":"version_conflict"}}""" }
        val unreadable = server { HttpStatusCode.Conflict to "<html>" }

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), unknown.mail().archive(THREAD))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), unreadable.mail().trash(THREAD))
    }

    @Test
    fun aMissingThreadIsNotFound() = runTest {
        val server = server { HttpStatusCode.NotFound to "{}" }

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), server.mail().thread(THREAD))
    }
}
