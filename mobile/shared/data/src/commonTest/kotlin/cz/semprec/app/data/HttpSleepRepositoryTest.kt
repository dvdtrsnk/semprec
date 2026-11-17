package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.NewSleepPlan
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepPlanChange
import cz.semprec.app.domain.SleepSettingsChange
import cz.semprec.app.domain.SleepSound
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
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SERVER = "https://s.example"
private const val SCHEMA =
    """{"databases":[{"databaseId":"db-set","key":"sleepSettings"},{"databaseId":"db-plan","key":"sleepPlans"},""" +
        """{"databaseId":"db-night","key":"sleepNights"},{"databaseId":"db-x","key":null}]}"""
private const val SETTINGS_ITEM =
    """{"id":"set1","updatedAt":"2026-10-16T08:00:00.000Z","version":"1",""" +
        """"properties":{"enabled":true,"showInCalendar":true,"muteSemp":false,""" +
        """"alarmSound":"piano","alarmSnooze":true,"goalMinutes":480,"prepReminder":true,"prepReminderMinutes":30,""" +
        """"systemActive":true}}"""
private const val WEEKDAY_PLAN =
    """{"id":"p1","version":"2","properties":{"name":"Weekdays","wakeDays":["mon","tue","wed","thu","fri"],""" +
        """"bedTime":"23:00","wakeTime":"06:45","alarm":true,"position":0}}"""
private const val WEEKEND_PLAN =
    """{"id":"p2","version":"3","properties":{"name":"Weekend","wakeDays":["sat","sun"],"bedTime":"00:00",""" +
        """"wakeTime":"08:30"}}"""
private const val NIGHT =
    """{"night":"2026-10-16","planId":"p1","planName":"Weekdays","bedTime":"23:00","wakeTime":"06:45",""" +
        """"alarm":true,"changed":false,"durationMinutes":465,"bedAt":"x","wakeAt":"y","prepReminderAt":null}"""

class HttpSleepRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpSleepRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession(SERVER, "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpSleepRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun HttpRequestData.path() = url.encodedPath

    private fun MockRequestHandleScope.reads(request: HttpRequestData): HttpResponseData = when (request.path()) {
        "/api/schema" -> json(SCHEMA)
        "/api/databases/db-set/query" -> json("""{"items":[$SETTINGS_ITEM],"nextCursor":null}""")
        "/api/databases/db-plan/query" -> json("""{"items":[$WEEKEND_PLAN,$WEEKDAY_PLAN],"nextCursor":null}""")
        "/api/sleep/nights" -> json("""{"nights":[$NIGHT],"enabled":true}""")
        else -> json("{}", HttpStatusCode.NotFound)
    }

    private fun sent(index: Int): JsonObject = Json.parseToJsonElement(bodies[index]).jsonObject

    @Test
    fun theOverviewReadsSettingsPlansAndTheNight() = runTest {
        val repo = repository { reads(it) }

        val result = repo.overview(CalendarDay(2026, 10, 16))

        val overview = assertIs<RepositoryResult.Content<*>>(result).value as cz.semprec.app.domain.SleepOverview
        assertEquals("set1", overview.settings.itemId)
        assertEquals(SleepSound.PIANO, overview.settings.alarmSound)
        assertEquals(480, overview.settings.goalMinutes)
        assertEquals(setOf(6, 7), overview.plans.single { it.id == "p2" }.wakeDays)
        assertEquals(false, overview.plans.single { it.id == "p2" }.alarm)
        assertEquals(setOf(1, 2, 3, 4, 5), overview.plans.single { it.id == "p1" }.wakeDays)
        assertEquals(465, overview.night?.durationMinutes)
        assertEquals("p1", overview.night?.planId)
        val night = requests.single { it.path() == "/api/sleep/nights" }
        assertEquals("2026-10-16", night.url.parameters["from"])
        assertEquals("2026-10-16", night.url.parameters["to"])
        assertEquals("Bearer tok", night.headers[HttpHeaders.Authorization])
    }

    @Test
    fun theOverviewWithoutANightDoesNotAskForNights() = runTest {
        val repo = repository { reads(it) }

        val overview = (repo.overview(null) as RepositoryResult.Content).value
        assertNull(overview.night)
        assertTrue(requests.none { it.path() == "/api/sleep/nights" })
    }

    @Test
    fun theDatabasesAreFoundOnlyOnce() = runTest {
        val repo = repository { reads(it) }

        repo.overview(null)
        repo.overview(null)

        assertEquals(1, requests.count { it.path() == "/api/schema" })
    }

    @Test
    fun aTenantWithoutTheSleepDatabasesIsNotFound() = runTest {
        val repo = repository { json("""{"databases":[{"databaseId":"x","key":"tasks"}]}""") }

        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(repo.overview(null)).kind)
    }

    @Test
    fun aFailingReadIsAFailureAndAnUnreadablePlanIsInvalidData() = runTest {
        val down = repository { json("{}", HttpStatusCode.ServiceUnavailable) }
        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(down.overview(null)).kind)

        val badPlan = """{"id":"p3","version":"4","properties":{"name":"X","bedTime":"late","wakeTime":"07:00"}}"""
        val invalid = repository {
            when (it.path()) {
                "/api/databases/db-plan/query" -> json("""{"items":[$badPlan]}""")
                else -> reads(it)
            }
        }
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(invalid.overview(null)).kind)
    }

    @Test
    fun aSettingsWithoutItemsIsNotFound() = runTest {
        val repo = repository {
            when (it.path()) {
                "/api/databases/db-set/query" -> json("""{"items":[]}""")
                else -> reads(it)
            }
        }
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(repo.overview(null)).kind)
    }

    @Test
    fun aSettingsChangeReadsTheVersionAndPatchesOnlyTheChangedKeys() = runTest {
        val repo = repository { request ->
            when {
                request.method == HttpMethod.Get && request.path() == "/api/items/set1" -> json(SETTINGS_ITEM)
                request.method == HttpMethod.Patch && request.path() == "/api/items/set1" -> json(SETTINGS_ITEM)
                else -> reads(request)
            }
        }

        val result = repo.updateSettings("set1", SleepSettingsChange(goalMinutes = 450, alarmSound = SleepSound.BIRDS))

        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(listOf(HttpMethod.Get, HttpMethod.Patch), requests.map { it.method })
        val body = sent(1)
        assertEquals("1", body.getValue("ifVersion").jsonPrimitive.content)
        val properties = body.getValue("properties").jsonObject
        assertEquals(setOf("goalMinutes", "alarmSound"), properties.keys)
        assertEquals("450", properties.getValue("goalMinutes").jsonPrimitive.content)
        assertEquals("birds", properties.getValue("alarmSound").jsonPrimitive.content)
    }

    @Test
    fun aPlanChangeWritesWeekdayNamesAndTimes() = runTest {
        val repo = repository { request ->
            when (request.method) {
                HttpMethod.Get, HttpMethod.Patch -> json(WEEKDAY_PLAN)
                else -> reads(request)
            }
        }

        repo.updatePlan(
            "p1",
            SleepPlanChange(wakeDays = setOf(6, 1), bed = ClockTime(22 * 60 + 5), alarm = false),
        )

        val properties = sent(1).getValue("properties").jsonObject
        assertEquals("""["mon","sat"]""", properties.getValue("wakeDays").toString())
        assertEquals("22:05", properties.getValue("bedTime").jsonPrimitive.content)
        assertEquals("false", properties.getValue("alarm").jsonPrimitive.content)
        assertEquals(setOf("wakeDays", "bedTime", "alarm"), properties.keys)
    }

    @Test
    fun aConflictOnPatchIsRejected() = runTest {
        val repo = repository { request ->
            when (request.method) {
                HttpMethod.Get -> json(WEEKDAY_PLAN)
                else -> json("{}", HttpStatusCode.Conflict)
            }
        }
        val result = repo.updatePlan("p1", SleepPlanChange(alarm = true))
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test
    fun aMissingItemOnTheVersionReadStopsThePatch() = runTest {
        val repo = repository { json("{}", HttpStatusCode.NotFound) }
        val result = repo.updatePlan("p1", SleepPlanChange(alarm = true))
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(result).kind)
        assertEquals(1, requests.size)
    }

    @Test
    fun aCreatedPlanAnswersItsIdAndSendsEveryProperty() = runTest {
        val repo = repository { request ->
            when {
                request.method == HttpMethod.Post && request.path() == "/api/databases/db-plan/items" ->
                    json(WEEKEND_PLAN, HttpStatusCode.Created)
                else -> reads(request)
            }
        }

        val result = repo.createPlan(
            NewSleepPlan("Other days", setOf(7, 6), ClockTime(23 * 60), ClockTime(7 * 60), true, 2),
        )

        assertEquals(RepositoryResult.Content("p2"), result)
        // The schema read comes first, so the create is the last request.
        val properties = Json.parseToJsonElement(bodies.last()).jsonObject.getValue("properties").jsonObject
        assertEquals("Other days", properties.getValue("name").jsonPrimitive.content)
        assertEquals("""["sat","sun"]""", properties.getValue("wakeDays").toString())
        assertEquals("23:00", properties.getValue("bedTime").jsonPrimitive.content)
        assertEquals("2", properties.getValue("position").jsonPrimitive.content)
    }

    @Test
    fun deletingAPlanSendsADeleteWithoutABody() = runTest {
        val repo = repository { json("{}") }
        assertEquals(RepositoryResult.Content(Unit), repo.deletePlan("p2"))
        assertEquals(HttpMethod.Delete, requests.single().method)
        assertEquals("/api/items/p2", requests.single().path())
        assertEquals("", bodies.single())
    }

    @Test
    fun aNightChangeSendsOnlyTheGivenFieldsAndAnswersTheNight() = runTest {
        val repo = repository { json("""{"night":$NIGHT}""") }

        val change = SleepNightChange(bed = ClockTime(22 * 60), alarm = false)
        val result = repo.changeNight(CalendarDay(2026, 10, 16), change)

        val night = (assertIs<RepositoryResult.Content<*>>(result).value as cz.semprec.app.domain.SleepNight)
        assertEquals("Weekdays", night.planName)
        assertEquals(HttpMethod.Put, requests.single().method)
        assertEquals("/api/sleep/nights/2026-10-16", requests.single().path())
        assertEquals(setOf("bedTime", "alarm"), sent(0).keys)
        assertEquals("22:00", sent(0).getValue("bedTime").jsonPrimitive.content)
    }

    @Test
    fun resettingANightSendsExplicitNulls() = runTest {
        val repo = repository { json("""{"night":null}""") }

        val result = repo.changeNight(CalendarDay(2026, 10, 16), SleepNightChange(reset = true))

        assertEquals(RepositoryResult.Content(null), result)
        assertEquals(setOf("bedTime", "wakeTime", "alarm"), sent(0).keys)
        assertTrue(sent(0).values.all { it == JsonNull })
    }

    @Test
    fun anUnreadableNightAnswerIsInvalidData() = runTest {
        val unreadable = """{"night":"nope","bedTime":"23:00","wakeTime":"07:00","alarm":false,"changed":true,""" +
            """"durationMinutes":1}"""
        val repo = repository { json("""{"night":$unreadable}""") }
        val result = repo.changeNight(CalendarDay(2026, 10, 16), SleepNightChange(alarm = false))
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(result).kind)
    }
}
