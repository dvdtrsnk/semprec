package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailConnectOutcome
import cz.semprec.app.domain.MailConnectRefusal
import cz.semprec.app.domain.MailFolder
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.OAuthOutcome
import cz.semprec.app.domain.OAuthProvider
import cz.semprec.app.domain.OAuthSignIn
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.plugins.HttpTimeoutCapability
import io.ktor.client.request.HttpRequestData
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

        assertEquals(RepositoryResult.Content(MailConnectOutcome.Connected("new")), answer)
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

    private val rejected = RepositoryResult.Failure(FailureKind.REJECTED)
    private val unavailable = RepositoryResult.Failure(FailureKind.UNAVAILABLE)

    /** Each answer of the server and what the password routes make of it. */
    private val refusals = listOf<Triple<HttpStatusCode, String, RepositoryResult<MailConnectOutcome>>>(
        Triple(HttpStatusCode.BadRequest, errorBody("mail_auth_failed"), refused(MailConnectRefusal.WRONG_CREDENTIALS)),
        Triple(
            HttpStatusCode.BadRequest,
            errorBody("mail_app_password_required"),
            refused(MailConnectRefusal.APP_PASSWORD_REQUIRED),
        ),
        Triple(
            HttpStatusCode.BadRequest,
            errorBody("mail_server_unreachable"),
            refused(MailConnectRefusal.SERVER_UNREACHABLE),
        ),
        Triple(HttpStatusCode.BadRequest, errorBody("mail_tls_failed"), refused(MailConnectRefusal.TLS_FAILED)),
        Triple(HttpStatusCode.BadRequest, errorBody("caldav_auth_failed"), refused(MailConnectRefusal.CALDAV_REFUSED)),
        Triple(
            HttpStatusCode.BadRequest,
            errorBody("caldav_server_unreachable"),
            refused(MailConnectRefusal.CALDAV_UNREACHABLE),
        ),
        Triple(
            HttpStatusCode.BadRequest,
            errorBody("caldav_server_invalid"),
            refused(MailConnectRefusal.CALDAV_UNREACHABLE),
        ),
        Triple(
            HttpStatusCode.Conflict,
            errorBody("provider_account_already_connected"),
            refused(MailConnectRefusal.ALREADY_CONNECTED),
        ),
        Triple(HttpStatusCode.TooManyRequests, errorBody("rate_limited"), refused(MailConnectRefusal.RATE_LIMITED)),
        // A 429 says rate limited even without a body the app can read.
        Triple(HttpStatusCode.TooManyRequests, "", refused(MailConnectRefusal.RATE_LIMITED)),
        // The code at the top level of the body is read too.
        Triple(
            HttpStatusCode.BadRequest,
            """{"code":"mail_auth_failed"}""",
            refused(MailConnectRefusal.WRONG_CREDENTIALS),
        ),
        // Anything else keeps the kind the status maps to.
        Triple(HttpStatusCode.BadRequest, errorBody("validation_failed"), rejected),
        Triple(HttpStatusCode.Conflict, errorBody("mailbox_not_password"), rejected),
        Triple(HttpStatusCode.BadRequest, "not json", rejected),
        Triple(HttpStatusCode.BadRequest, """{"error":"text"}""", rejected),
        Triple(HttpStatusCode.NotFound, errorBody("not_found"), RepositoryResult.Failure(FailureKind.NOT_FOUND)),
        Triple(
            HttpStatusCode.PayloadTooLarge,
            errorBody("payload_too_large"),
            RepositoryResult.Failure(FailureKind.INVALID_DATA),
        ),
        Triple(HttpStatusCode.InternalServerError, errorBody("internal_error"), unavailable),
        Triple(HttpStatusCode.BadGateway, "", unavailable),
    )

    private fun errorBody(code: String) = """{"error":{"code":"$code","message":"m"}}"""

    private fun refused(reason: MailConnectRefusal): RepositoryResult<MailConnectOutcome> =
        RepositoryResult.Content(MailConnectOutcome.Refused(reason))

    @Test
    fun aLoginTheServerRefusesNamesItsReason() = runTest {
        val account = MailPasswordAccount(MailPasswordProvider.ICLOUD, "me@icloud.com", "bad", null, null)
        for ((status, body, expected) in refusals) {
            val server = MailTestServer { status to body }

            assertEquals(expected, server.mailboxes().connect(account), "$status $body")
            assertEquals(expected, server.mailboxes().updatePassword(BOX, "bad", null), "$status $body")
        }
    }

    @Test
    fun aPasswordSignInAgainPutsThePasswordAndAGivenUserName() = runTest {
        // The answer is the item; its sync status reads the old state until the queued sync has run.
        val server = MailTestServer {
            ok("""{"id":"$BOX","databaseId":"d","properties":{"syncStatus":"needsReauthorization"},"version":"9"}""")
        }
        val mailboxes = server.mailboxes()

        val connected = RepositoryResult.Content(MailConnectOutcome.Connected(BOX))
        assertEquals(connected, mailboxes.updatePassword(BOX, "pw", null))
        assertEquals(
            connected,
            mailboxes.updatePassword(BOX, "pw", "me@firma.cz"),
        )

        assertEquals(listOf(HttpMethod.Put, HttpMethod.Put), server.requests.map { it.method })
        assertEquals(
            listOf("/api/mail/mailboxes/$BOX/password", "/api/mail/mailboxes/$BOX/password"),
            server.requests.map { it.url.encodedPath },
        )
        val (kept, given) = server.bodies.map { Json.parseToJsonElement(it).jsonObject }
        assertEquals(setOf("password"), kept.keys)
        assertEquals("pw", kept.getValue("password").jsonPrimitive.content)
        assertEquals("me@firma.cz", given.getValue("username").jsonPrimitive.content)
        // The server checks the login on the mail servers before it answers, as for a new mailbox.
        val bound = server.requests.first().getCapabilityOrNull(HttpTimeoutCapability)?.requestTimeoutMillis
        assertTrue(bound != null && bound >= 180_000L)
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

    private val authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=st%2B1&scope=a+b"

    private fun oauthRoutes(request: HttpRequestData): Pair<HttpStatusCode, String>? = when (request.url.encodedPath) {
        "/api/mail/mailboxes/oauth/start", "/api/mail/mailboxes/$BOX/reauthorize" ->
            ok("""{"authorizeUrl":"$authorizeUrl"}""")
        "/api/mail/mailboxes/oauth/complete" -> HttpStatusCode.Created to """{"mailboxId":"$BOX"}"""
        else -> null
    }

    private fun JsonObject.services() = get("services")?.jsonArray?.map { it.jsonPrimitive.content }

    @Test
    fun aSignInStartsWithTheProviderMailAlwaysAndTheAppAsTheReturnAndKeepsTheState() = runTest {
        val server = MailTestServer(::oauthRoutes)
        val accounts = server.mailboxes()

        val google = accounts.startSignIn(OAuthProvider.GOOGLE, setOf(InternetService.CALENDARS))
        accounts.startSignIn(OAuthProvider.MICROSOFT, emptySet())

        assertEquals(RepositoryResult.Content(OAuthSignIn(authorizeUrl, "st+1")), google)
        assertEquals(listOf(HttpMethod.Post, HttpMethod.Post), server.requests.map { it.method })
        val (first, second) = server.bodies.map { Json.parseToJsonElement(it).jsonObject }
        assertEquals("gmail", first.getValue("provider").jsonPrimitive.content)
        assertEquals(listOf("mail", "calendars"), first.services())
        assertEquals("app", first.getValue("redirectTarget").jsonPrimitive.content)
        assertEquals("outlook", second.getValue("provider").jsonPrimitive.content)
        assertEquals(listOf("mail"), second.services())
    }

    @Test
    fun aReauthorizationNamesServicesOnlyWhenAskedForMore() = runTest {
        val server = MailTestServer(::oauthRoutes)
        val accounts = server.mailboxes()

        accounts.startReauthorization(BOX, emptySet())
        accounts.startReauthorization(BOX, setOf(InternetService.CALENDARS))

        assertEquals(
            listOf("/api/mail/mailboxes/$BOX/reauthorize", "/api/mail/mailboxes/$BOX/reauthorize"),
            server.requests.map { it.url.encodedPath },
        )
        val (renew, consent) = server.bodies.map { Json.parseToJsonElement(it).jsonObject }
        assertNull(renew.services())
        assertEquals("app", renew.getValue("redirectTarget").jsonPrimitive.content)
        assertEquals(listOf("mail", "calendars"), consent.services())
    }

    @Test
    fun aProviderPageWithoutAStateIsUnreadable() = runTest {
        val server = MailTestServer { ok("""{"authorizeUrl":"https://accounts.google.com/o/oauth2/v2/auth"}""") }

        assertEquals(
            RepositoryResult.Failure(FailureKind.INVALID_DATA),
            server.mailboxes().startSignIn(OAuthProvider.GOOGLE, emptySet()),
        )
    }

    @Test
    fun theCodeTheBrowserBroughtBackCompletesTheSignIn() = runTest {
        val server = MailTestServer(::oauthRoutes)
        val signIn = OAuthSignIn(authorizeUrl, "st+1")

        val outcome = server.mailboxes().finishSignIn(signIn, "semprec://oauth?state=st%2B1&code=4%2F0Ab")

        assertEquals(RepositoryResult.Content(OAuthOutcome.Connected(BOX)), outcome)
        val body = Json.parseToJsonElement(server.bodies.single()).jsonObject
        assertEquals("/api/mail/mailboxes/oauth/complete", server.requests.single().url.encodedPath)
        assertEquals("st+1", body.getValue("state").jsonPrimitive.content)
        assertEquals("4/0Ab", body.getValue("code").jsonPrimitive.content)
    }

    @Test
    fun aProviderErrorIsADeclineAndAForeignOrBrokenReturnIsUnreadableAndNeitherIsSent() = runTest {
        val server = MailTestServer(::oauthRoutes)
        val accounts = server.mailboxes()
        val signIn = OAuthSignIn(authorizeUrl, "st+1")
        val unreadable = listOf(
            "semprec://oauth?state=other&code=c",
            "semprec://oauth?code=c",
            "semprec://oauth?state=st%2B1",
            "semprec://oauth?state=st%2B1&code=",
            "semprec://elsewhere?state=st%2B1&code=c",
            "https://oauth?state=st%2B1&code=c",
            "not a url",
        )

        assertEquals(
            RepositoryResult.Content(OAuthOutcome.Declined),
            accounts.finishSignIn(signIn, "semprec://oauth?state=st%2B1&error=access_denied"),
        )
        for (url in unreadable) {
            assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), accounts.finishSignIn(signIn, url), url)
        }
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun aSignedInAccountTheServerRefusesNamesWhy() = runTest {
        val refusals = listOf(
            Triple(HttpStatusCode.BadRequest, "mail_reauth_wrong_account", MailConnectRefusal.WRONG_ACCOUNT),
            Triple(HttpStatusCode.Conflict, "provider_account_already_connected", MailConnectRefusal.ALREADY_CONNECTED),
            Triple(HttpStatusCode.BadRequest, "mail_consent_missing", MailConnectRefusal.MAIL_CONSENT_MISSING),
        )
        for ((status, code, refusal) in refusals) {
            val server = MailTestServer { status to """{"error":{"code":"$code"}}""" }

            assertEquals(
                RepositoryResult.Content(OAuthOutcome.Refused(refusal)),
                server.mailboxes().finishSignIn(OAuthSignIn(authorizeUrl, "s"), "semprec://oauth?state=s&code=c"),
                code,
            )
        }
    }

    @Test
    fun aCompletionRefusedForAnotherReasonIsARejection() = runTest {
        val server = MailTestServer {
            HttpStatusCode.BadRequest to """{"error":{"code":"validation_failed"}}"""
        }

        assertEquals(
            RepositoryResult.Failure(FailureKind.REJECTED),
            server.mailboxes().finishSignIn(OAuthSignIn(authorizeUrl, "s"), "semprec://oauth?state=s&code=c"),
        )
    }
}
