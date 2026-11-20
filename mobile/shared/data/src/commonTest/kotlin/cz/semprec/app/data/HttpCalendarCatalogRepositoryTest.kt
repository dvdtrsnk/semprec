package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.CalendarCancellationImpact
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarEdit
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarInvitation
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.InvitationAnswer
import cz.semprec.app.domain.InvitationKind
import cz.semprec.app.domain.InvitationStatus
import cz.semprec.app.domain.RepositoryResult
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val SERVER = "https://s.example"
private const val SCHEMA =
    """{"databases":[{"databaseId":"db-cal","key":"calendars"},{"databaseId":"db-inv","key":"invitations"}]}"""
private const val CALENDARS =
    """{"items":[{"id":"c1","version":"1","properties":{"name":"Work","color":"#007AFF","notify":true,""" +
        """"hidden":false}},""" +
        """{"id":"c2","version":"2","properties":{"name":"Tasks","color":"#007AFF","systemKey":"tasks",""" +
        """"isDefault":false}},""" +
        """{"id":"c3","version":"3","properties":{"name":"Personal","color":"#5856D6","isDefault":true,""" +
        """"notify":true}}]}"""
private const val INVITATIONS =
    """{"items":[{"id":"i2","version":"7","properties":{"title":"Dinner","status":"accepted",""" +
        """"startsAt":"2026-10-23T17:00:00.000Z",""" +
        """"endsAt":"2026-10-23T20:00:00.000Z","timeZone":"Europe/Prague","allDay":false,"place":"Vinohrady",""" +
        """"organizerName":"Tomas","organizerEmail":"t@example.com","kind":"invite"}},""" +
        """{"id":"i1","version":"7","properties":{"title":"Review","status":"pending",""" +
        """"startsAt":"2026-10-22T11:00:00.000Z",""" +
        """"kind":"invite"}},{"id":"i3","version":"7","properties":{"title":"Notice","status":"pending",""" +
        """"kind":"sharedCalendarNotice"}},""" +
        """{"id":"i4","version":"7","properties":{"title":"Odd","status":"strange"}},{"id":"i5",""" +
        """"version":"7","properties":{"status":"pending"}}]}"""

/**
 * Account calendars: one with only the provider's name and colour, one renamed and recoloured here and read-only, one
 * whose account the server did not name and with no colour at all, and one without any name, which is not shown.
 * An own calendar's stray remote fields are ignored.
 */
private const val ACCOUNT_CALENDARS =
    """{"items":[{"id":"g1","version":"1","properties":{"kind":"account","name":null,"color":null,""" +
        """"remoteName":"Family","remoteColor":"#0B8043","readOnly":false},"relations":{"account":[{"id":"m1"}]}},""" +
        """{"id":"g2","version":"1","properties":{"kind":"account","name":"Holidays","color":"#FF3B30",""" +
        """"remoteName":"Svátky","remoteColor":"#16A765","readOnly":true},"relations":{"account":[{"id":"m1"}]}},""" +
        """{"id":"g3","version":"1","properties":{"kind":"account","remoteName":"Work"},""" +
        """"relations":{"account":[]}},""" +
        """{"id":"g4","version":"1","properties":{"kind":"account","remoteColor":"#0B8043"}},""" +
        """{"id":"own","version":"1","properties":{"name":"Mine","color":"#007AFF","remoteName":"x",""" +
        """"readOnly":true},"relations":{"account":[]}}]}"""

class HttpCalendarCatalogRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()
    private val changes = CalendarChanges()
    private var handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData = { reads(it) }

    private fun api(): AuthenticatedApi {
        val storage = InMemorySessionStorage().apply { save(StoredSession(SERVER, "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return AuthenticatedApi(ApiClient(engine), storage) {}
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun MockRequestHandleScope.reads(request: HttpRequestData): HttpResponseData =
        when (request.url.encodedPath) {
            "/api/schema" -> json(SCHEMA)
            "/api/databases/db-cal/query" -> json(CALENDARS)
            "/api/databases/db-inv/query" -> json(INVITATIONS)
            "/api/calendar/calendars/c1/cancellation-impact" ->
                json("""{"eventCount":4,"recipientCount":2,"cancellationCount":1}""")
            else -> json("""{"id":"c9","version":"9","properties":{}}""")
        }

    private fun sent(index: Int): JsonObject = Json.parseToJsonElement(bodies[index]).jsonObject

    private fun info(kind: CalendarKind = CalendarKind.OWN) =
        CalendarInfo("c1", "Work", "#007AFF", true, false, false, kind, null, "1")

    @Test fun `the calendars are read with their kinds and flags`() = runTest {
        val result = HttpCalendarCatalogRepository(api(), changes).calendars()
        val calendars = assertIs<RepositoryResult.Content<List<CalendarInfo>>>(result).value
        assertEquals(listOf("c1", "c2", "c3"), calendars.map { it.id })
        assertEquals(listOf(CalendarKind.OWN, CalendarKind.SYSTEM, CalendarKind.OWN), calendars.map { it.kind })
        assertEquals("tasks", calendars[1].systemKey)
        assertEquals(true, calendars[2].isDefault)
        assertEquals(true, calendars[0].notify)
    }

    @Test fun `the calendars are queried with the account of each synced calendar`() = runTest {
        HttpCalendarCatalogRepository(api(), changes).calendars()
        val query = requests.indexOfFirst { it.url.encodedPath == "/api/databases/db-cal/query" }
        assertEquals(
            Json.parseToJsonElement("""{"include":{"relations":{"account":[]}}}"""),
            Json.parseToJsonElement(bodies[query]),
        )
    }

    @Test fun `an account calendar shows the provider name and colour unless the person set their own`() = runTest {
        handler = { request ->
            if (request.url.encodedPath == "/api/databases/db-cal/query") json(ACCOUNT_CALENDARS) else reads(request)
        }
        val result = HttpCalendarCatalogRepository(api(), changes).calendars()
        val calendars = assertIs<RepositoryResult.Content<List<CalendarInfo>>>(result).value.associateBy { it.id }
        assertEquals(setOf("g1", "g2", "g3", "own"), calendars.keys)

        val remote = calendars.getValue("g1")
        assertEquals(CalendarKind.ACCOUNT, remote.kind)
        assertEquals("m1", remote.accountId)
        assertEquals("Family" to "#0B8043", remote.name to remote.color)
        assertEquals(true, remote.usesRemoteColor)
        assertEquals(false, remote.readOnly)

        // Recoloured and renamed here: the next sync changes only the provider's values, which stay apart.
        val recoloured = calendars.getValue("g2")
        assertEquals("Holidays" to "#FF3B30", recoloured.name to recoloured.color)
        assertEquals("Svátky" to "#16A765", recoloured.remoteName to recoloured.remoteColor)
        assertEquals(false, recoloured.usesRemoteColor)
        assertEquals(true, recoloured.readOnly)

        val colourless = calendars.getValue("g3")
        assertEquals("#8E8E93", colourless.color)
        assertEquals(null, colourless.accountId)

        val own = calendars.getValue("own")
        assertEquals(CalendarKind.OWN, own.kind)
        val accountFields = listOf(own.accountId, own.remoteName, own.remoteColor, own.readOnly)
        assertEquals(listOf(null, null, null, false), accountFields)
    }

    @Test fun `going back to the provider colour clears the colour set here`() = runTest {
        val account = info(CalendarKind.ACCOUNT)
        HttpCalendarCatalogRepository(api(), changes).edit(account, CalendarEdit(useRemoteColor = true))
        val properties = sent(0)["properties"]?.jsonObject
        assertEquals<Map<String, Any>?>(mapOf("color" to JsonNull), properties)
    }

    @Test fun `the version a calendar is listed with is what its edit sends and not its updatedAt`() = runTest {
        handler = { request ->
            if (request.url.encodedPath == "/api/databases/db-cal/query") {
                json(
                    """{"items":[{"id":"c1","updatedAt":"2026-10-16T08:00:00.000Z","version":"42",""" +
                        """"properties":{"name":"Work","color":"#007AFF"}}]}""",
                )
            } else {
                reads(request)
            }
        }
        val repo = HttpCalendarCatalogRepository(api(), changes)
        val listed = assertIs<RepositoryResult.Content<List<CalendarInfo>>>(repo.calendars()).value.single()
        assertEquals("42", listed.version)

        repo.edit(listed, CalendarEdit(notify = false))

        assertEquals(HttpMethod.Patch, requests.last().method)
        assertEquals("42", sent(bodies.lastIndex)["ifVersion"]?.jsonPrimitive?.content)
    }

    @Test fun `an edit patches only the named fields against the listed version`() = runTest {
        val repo = HttpCalendarCatalogRepository(api(), changes)
        val result = repo.edit(info(), CalendarEdit(name = "Job", hidden = true))
        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(HttpMethod.Patch, requests.single().method)
        assertEquals("/api/items/c1", requests.single().url.encodedPath)
        val body = sent(0)
        assertEquals("1", body["ifVersion"]?.jsonPrimitive?.content)
        val properties = body["properties"]!!.jsonObject
        assertEquals(setOf("name", "hidden"), properties.keys)
        assertEquals("Job", properties["name"]?.jsonPrimitive?.content)
        assertEquals(1, changes.revision.value)
    }

    @Test fun `colour and notification are written as given`() = runTest {
        HttpCalendarCatalogRepository(api(), changes).edit(info(), CalendarEdit(color = "#FF9500", notify = false))
        val properties = sent(0)["properties"]!!.jsonObject
        assertEquals("#FF9500", properties["color"]?.jsonPrimitive?.content)
        assertEquals("false", properties["notify"]?.jsonPrimitive?.content)
    }

    @Test fun `a new calendar is created visible and notifying`() = runTest {
        val result = HttpCalendarCatalogRepository(api(), changes).create("Trips", "#FF9500")
        assertEquals(RepositoryResult.Content("c9"), result)
        val create = requests.last()
        assertEquals("/api/databases/db-cal/items", create.url.encodedPath)
        val properties = sent(requests.indexOf(create))["properties"]!!.jsonObject
        assertEquals("Trips", properties["name"]?.jsonPrimitive?.content)
        assertEquals("false", properties["hidden"]?.jsonPrimitive?.content)
        assertEquals(1, changes.revision.value)
    }

    @Test fun `the impact of deleting a calendar is read before the delete`() = runTest {
        val repo = HttpCalendarCatalogRepository(api(), changes)
        assertEquals(RepositoryResult.Content(CalendarCancellationImpact(4, 2, 1)), repo.cancellationImpact("c1"))
        assertEquals(RepositoryResult.Content(Unit), repo.delete("c1"))
        assertEquals(HttpMethod.Delete, requests.last().method)
        assertEquals("/api/items/c1", requests.last().url.encodedPath)
    }

    @Test fun `failures of the calendar writes come back and change nothing`() = runTest {
        handler = { json("{}", HttpStatusCode.Conflict) }
        val repo = HttpCalendarCatalogRepository(api(), changes)
        val edit = repo.edit(info(), CalendarEdit(hidden = true))
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(edit).kind)
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(repo.delete("c1")).kind)
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(repo.cancellationImpact("c1")).kind)
        assertEquals(0, changes.revision.value)
    }

    @Test fun `creating a calendar fails when the database is missing or the write is refused`() = runTest {
        handler = { json("""{"databases":[]}""") }
        val missing = HttpCalendarCatalogRepository(api(), changes).create("A", "#000000")
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(missing).kind)
        handler = { if (it.url.encodedPath == "/api/schema") json(SCHEMA) else json("{}", HttpStatusCode.BadRequest) }
        val refused = HttpCalendarCatalogRepository(api(), changes).create("A", "#000000")
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(refused).kind)
    }

    @Test fun `invitations are read oldest first and the unreadable ones are left out`() = runTest {
        val result = HttpInvitationRepository(api(), changes).invitations()
        val items = assertIs<RepositoryResult.Content<List<CalendarInvitation>>>(result).value
        assertEquals(listOf("i3", "i1", "i2"), items.map { it.id })
        assertEquals(InvitationKind.SHARED_CALENDAR_NOTICE, items[0].kind)
        assertEquals(InvitationStatus.PENDING, items[1].status)
        assertEquals("Europe/Prague", items[2].timeZone)
        assertEquals("Vinohrady", items[2].place)
        assertEquals("Tomas", items[2].organizerName)
    }

    @Test fun `each answer is sent with its wire name and the change is announced`() = runTest {
        val repo = HttpInvitationRepository(api(), changes)
        listOf(
            InvitationAnswer.ACCEPT to "accepted",
            InvitationAnswer.TENTATIVE to "tentative",
            InvitationAnswer.DECLINE to "declined",
            InvitationAnswer.ACKNOWLEDGE to "acknowledged",
        ).forEachIndexed { index, (answer, wire) ->
            assertEquals(RepositoryResult.Content(Unit), repo.respond("i1", answer))
            assertEquals("/api/calendar/invitations/i1/respond", requests[index].url.encodedPath)
            assertEquals(wire, sent(index)["response"]?.jsonPrimitive?.content)
        }
        assertEquals(4, changes.revision.value)
    }

    @Test fun `a conflicting answer fails and is not announced`() = runTest {
        handler = { json("{}", HttpStatusCode.Conflict) }
        val result = HttpInvitationRepository(api(), changes).respond("i1", InvitationAnswer.ACCEPT)
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
        assertEquals(0, changes.revision.value)
    }

    @Test fun `a failing invitations read comes back as a failure`() = runTest {
        handler = { json("{}", HttpStatusCode.ServiceUnavailable) }
        val result = HttpInvitationRepository(api(), changes).invitations()
        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(result).kind)
    }
}
