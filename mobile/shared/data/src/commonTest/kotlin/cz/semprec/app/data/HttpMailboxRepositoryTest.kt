package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailFolder
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.plugins.HttpTimeoutCapability
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val BOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

private const val MAILBOX = """{"id":"$BOX","name":"Gmail","provider":"gmail","primaryAddress":"me@gmail.com",
    "addresses":["me@gmail.com"],"syncMode":"gmailApi","syncStatus":"needsReauthorization",
    "initialSyncInProgress":false,"lastSuccessfulSyncAt":"2026-10-19T08:12:00.000Z",
    "failingSince":"2026-10-19T09:12:00.000Z","reason":"authFailed",
    "connectionLimit":{"value":3,"default":3,"applies":false},"autonomousSendProjectCount":2}"""

private const val FOLDERS = """[{"id":"f1","name":"Doručená pošta","specialPurpose":"inbox","behavior":"folder",
    "unreadCount":3,"totalCount":40}]"""

private const val IMAP_MAILBOX = """{"id":"x2","name":"Work","provider":"imap","primaryAddress":null,"addresses":[],
    "syncMode":"imap","syncStatus":null,"initialSyncInProgress":true,"lastSuccessfulSyncAt":null,"failingSince":null,
    "reason":null,"connectionLimit":{"value":5,"default":5,"applies":true},"autonomousSendProjectCount":0}"""

class HttpMailboxRepositoryTest {
    private fun MailTestServer.mailboxes() = HttpMailboxRepository(api())

    private fun routes(request: HttpRequestData): Pair<HttpStatusCode, String>? = when {
        request.url.encodedPath == "/api/mail/mailboxes" && request.method == HttpMethod.Get ->
            ok("""{"mailboxes":[$MAILBOX,$IMAP_MAILBOX]}""")
        request.url.encodedPath == "/api/mail/mailboxes" -> HttpStatusCode.Created to """{"id":"new"}"""
        request.url.encodedPath == "/api/mail/mailboxes/$BOX/folders" ->
            ok(FOLDERS)
        request.url.encodedPath == "/api/mail/mailboxes/$BOX/removal-impact" ->
            ok("""{"messages":120,"drafts":2,"threads":50,"attachmentsKept":7}""")
        request.url.encodedPath == "/api/mail/mailboxes/$BOX" && request.method == HttpMethod.Delete ->
            ok("""{"id":"$BOX"}""")
        request.url.encodedPath == "/api/mail/mailboxes/$BOX" -> ok(MAILBOX)
        request.url.encodedPath == "/api/accounts/$BOX/calendars/sync" -> HttpStatusCode.Accepted to "{}"
        request.url.encodedPath == "/api/items/$BOX" && request.method == HttpMethod.Get ->
            ok(
                """{"id":"$BOX","databaseId":"d","properties":{"name":"Gmail"},""" +
                    """"updatedAt":"2026-10-16T08:00:00.000Z","version":"7"}""",
            )
        request.url.encodedPath == "/api/items/$BOX" ->
            ok("""{"id":"$BOX","databaseId":"d","properties":{},"version":"8"}""")
        else -> null
    }

    @Test
    fun theListMapsTheSyncStateOfEveryMailbox() = runTest {
        val server = MailTestServer(::routes)

        val accounts = assertIs<RepositoryResult.Content<List<MailAccount>>>(server.mailboxes().mailboxes()).value

        val gmail = accounts.first()
        assertEquals(MailSyncStatus.NEEDS_REAUTHORIZATION, gmail.syncStatus)
        assertEquals("me@gmail.com", gmail.primaryAddress)
        assertEquals("2026-10-19T09:12:00.000Z", gmail.failingSince)
        assertEquals(2, gmail.autonomousSendProjectCount)
        assertFalse(gmail.connectionLimitApplies)
        val imap = accounts.last()
        assertEquals(MailSyncStatus.OK, imap.syncStatus)
        assertTrue(imap.initialSyncInProgress)
        assertTrue(imap.connectionLimitApplies)
        assertEquals(5, imap.connectionLimit)
        assertNull(imap.primaryAddress)
    }

    @Test
    fun aMailboxFoldersAndRemovalImpactAreRead() = runTest {
        val server = MailTestServer(::routes)
        val mailboxes = server.mailboxes()

        val folders = mailboxes.folders(BOX)
        val impact = mailboxes.removalImpact(BOX)
        val one = mailboxes.mailbox(BOX)

        assertEquals(RepositoryResult.Content(listOf(MailFolder("f1", "Doručená pošta", "inbox", 3, 40))), folders)
        assertEquals(RepositoryResult.Content(MailRemovalImpact(120, 2, 50, 7)), impact)
        assertEquals("Gmail", assertIs<RepositoryResult.Content<MailAccount>>(one).value.name)
    }

    @Test
    fun removingAMailboxDeletesIt() = runTest {
        val server = MailTestServer(::routes)

        assertEquals(RepositoryResult.Content(Unit), server.mailboxes().remove(BOX))

        assertEquals(HttpMethod.Delete, server.requests.single().method)
    }

    @Test
    fun anUnknownMailboxIsNotFound() = runTest {
        val server = MailTestServer { HttpStatusCode.NotFound to "{}" }

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), server.mailboxes().removalImpact(BOX))
    }

    @Test
    fun anIcloudMailboxIsConnectedWithoutServers() = runTest {
        val server = MailTestServer(::routes)

        val answer = server.mailboxes().connect(
            MailPasswordAccount(MailPasswordProvider.ICLOUD, "me@icloud.com", "app-pass", null, null),
        )

        assertEquals(RepositoryResult.Content(Unit), answer)
        val body = Json.parseToJsonElement(server.bodies.single()).jsonObject
        assertEquals(setOf("provider", "address", "password"), body.keys)
        assertEquals("icloud", body.getValue("provider").jsonPrimitive.content)
    }

    @Test
    fun aGenericMailboxCarriesBothServers() = runTest {
        val server = MailTestServer(::routes)

        server.mailboxes().connect(
            MailPasswordAccount(MailPasswordProvider.GENERIC, "me@firma.cz", "pw", "imap.firma.cz", "smtp.firma.cz"),
        )

        val body = Json.parseToJsonElement(server.bodies.single()).jsonObject
        assertEquals("generic", body.getValue("provider").jsonPrimitive.content)
        assertEquals("imap.firma.cz", body.getValue("imapHost").jsonPrimitive.content)
        assertEquals("smtp.firma.cz", body.getValue("smtpHost").jsonPrimitive.content)
    }

    @Test
    fun connectingWaitsForTheServersChecksWhileOtherRequestsKeepTheDefaultBound() = runTest {
        val server = MailTestServer(::routes)

        server.mailboxes().connect(
            MailPasswordAccount(MailPasswordProvider.GENERIC, "me@firma.cz", "pw", "imap.firma.cz", "smtp.firma.cz"),
        )
        server.mailboxes().mailboxes()

        val (connect, list) =
            server.requests.map { it.getCapabilityOrNull(HttpTimeoutCapability)?.requestTimeoutMillis }
        // Two protocols, each on up to two ports that may each take 45 s to time out on the server.
        assertTrue(connect != null && connect >= 180_000L)
        assertEquals(30_000L, list)
    }

    @Test
    fun aLoginTheServerRefusesIsARejection() = runTest {
        val server = MailTestServer { HttpStatusCode.BadRequest to """{"error":{"code":"mail_auth_failed"}}""" }
        val account = MailPasswordAccount(MailPasswordProvider.ICLOUD, "me@icloud.com", "bad", null, null)

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), server.mailboxes().connect(account))
    }

    @Test
    fun aRenameAndAConnectionLimitPatchTheItemWithTheVersionJustRead() = runTest {
        val server = MailTestServer(::routes)
        val mailboxes = server.mailboxes()

        assertEquals(RepositoryResult.Content(Unit), mailboxes.rename(BOX, "Osobní"))
        assertEquals(RepositoryResult.Content(Unit), mailboxes.setConnectionLimit(BOX, 4))

        val patches = server.requests.indices.filter { server.requests[it].method == HttpMethod.Patch }
        assertEquals(2, patches.size)
        val rename = Json.parseToJsonElement(server.bodies[patches[0]]).jsonObject
        assertEquals("7", rename.getValue("ifVersion").jsonPrimitive.content)
        assertEquals("Osobní", rename.getValue("properties").jsonObject.getValue("name").jsonPrimitive.content)
        val limit = Json.parseToJsonElement(server.bodies[patches[1]]).jsonObject
        assertEquals("4", limit.getValue("properties").jsonObject.getValue("connectionLimit").jsonPrimitive.content)
    }

    @Test
    fun accountsCarryTheirSwitchesAndTheCalendarStatus() = runTest {
        fun imapRow(id: String, fields: String) =
            IMAP_MAILBOX.replace("\"x2\"", "\"$id\"").replace("\"autonomousSendProjectCount\":0", fields)
        val rows = listOf(
            // No switches and no status: Mail on, Calendars off.
            MAILBOX,
            imapRow("x2", """"mailEnabled":false,"calendarsEnabled":true"""),
            imapRow("x3", """"calendarsEnabled":true,"calendarStatus":"needsConsent""""),
            imapRow("x4", """"calendarsEnabled":true,"calendarStatus":"somethingNew""""),
        )
        val server = MailTestServer { ok("""{"mailboxes":[${rows.joinToString(",")}]}""") }

        val accounts =
            assertIs<RepositoryResult.Content<List<InternetAccount>>>(server.mailboxes().accounts()).value

        assertEquals(
            listOf(
                Triple(true, false, CalendarSyncStatus.OFF),
                Triple(false, true, CalendarSyncStatus.PENDING),
                Triple(true, true, CalendarSyncStatus.NEEDS_CONSENT),
                Triple(true, true, CalendarSyncStatus.PENDING),
            ),
            accounts.map { Triple(it.mailEnabled, it.calendarsEnabled, it.calendarStatus) },
        )
        assertEquals(MailSyncStatus.NEEDS_REAUTHORIZATION, accounts.first().mailbox.syncStatus)
        assertEquals("/api/mail/mailboxes", server.requests.single().url.encodedPath)
    }

    @Test
    fun oneAccountIsReadFromItsMailbox() = runTest {
        val server = MailTestServer(::routes)

        val account = assertIs<RepositoryResult.Content<InternetAccount>>(server.mailboxes().account(BOX)).value

        assertEquals("Gmail", account.mailbox.name)
        assertEquals(CalendarSyncStatus.OFF, account.calendarStatus)
    }

    @Test
    fun aServiceSwitchPatchesItsPropertyWithTheVersionJustRead() = runTest {
        val server = MailTestServer(::routes)
        val accounts = server.mailboxes()

        assertEquals(RepositoryResult.Content(Unit), accounts.setServiceEnabled(BOX, InternetService.CALENDARS, true))
        assertEquals(RepositoryResult.Content(Unit), accounts.setServiceEnabled(BOX, InternetService.MAIL, false))

        val patches = server.requests.indices.filter { server.requests[it].method == HttpMethod.Patch }
        val bodies = patches.map { Json.parseToJsonElement(server.bodies[it]).jsonObject }
        assertEquals(listOf("7", "7"), bodies.map { it.getValue("ifVersion").jsonPrimitive.content })
        assertEquals(
            listOf(mapOf("calendarsEnabled" to "true"), mapOf("mailEnabled" to "false")),
            bodies.map { body ->
                body.getValue("properties").jsonObject.mapValues { it.value.jsonPrimitive.content }
            },
        )
    }

    @Test
    fun aSwitchTheServerRefusesWhileTheMailboxSyncsIsARejection() = runTest {
        val server = MailTestServer { request ->
            if (request.method == HttpMethod.Patch) {
                HttpStatusCode.Conflict to """{"error":{"code":"mailbox_sync_busy"}}"""
            } else {
                routes(request)
            }
        }

        assertEquals(
            RepositoryResult.Failure(FailureKind.REJECTED),
            server.mailboxes().setServiceEnabled(BOX, InternetService.MAIL, false),
        )
    }

    @Test
    fun syncingCalendarsNowPostsToTheAccount() = runTest {
        val server = MailTestServer(::routes)

        assertEquals(RepositoryResult.Content(Unit), server.mailboxes().syncCalendars(BOX))

        val request = server.requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/accounts/$BOX/calendars/sync", request.url.encodedPath)
    }

    @Test
    fun aCaldavServerIsSentOnlyWhenGiven() = runTest {
        val server = MailTestServer(::routes)

        server.mailboxes().connect(
            MailPasswordAccount(
                MailPasswordProvider.GENERIC,
                "me@firma.cz",
                "pw",
                "imap.firma.cz",
                "smtp.firma.cz",
                caldavUrl = "https://dav.firma.cz",
            ),
        )
        server.mailboxes().connect(
            MailPasswordAccount(MailPasswordProvider.GENERIC, "me@firma.cz", "pw", "imap.firma.cz", "smtp.firma.cz"),
        )

        val (with, without) = server.bodies.map { Json.parseToJsonElement(it).jsonObject }
        assertEquals("https://dav.firma.cz", with.getValue("caldavUrl").jsonPrimitive.content)
        assertFalse("caldavUrl" in without)
    }
}
