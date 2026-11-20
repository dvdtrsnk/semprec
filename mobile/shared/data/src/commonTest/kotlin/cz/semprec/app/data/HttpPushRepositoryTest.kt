package cz.semprec.app.data

import cz.semprec.app.core.ApnsEnvironment
import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.BadgeCounts
import cz.semprec.app.domain.ReminderKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.UpcomingReminder
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val SUBSCRIPTION = """{"subscription":{"id":"5f0c8a52-0000-4000-8000-000000000001","channel":"apns",
    "platform":"ios","deviceToken":"ab12","apnsEnvironment":"sandbox","revokedAt":null}}"""

class HttpPushRepositoryTest {

    @Test
    fun theTokenIsRegisteredAsAnApnsSubscriptionOfThePlatformAndEnvironment() = runTest {
        val cases = listOf(
            Triple(ApnsEnvironment.SANDBOX, AppPlatform.IOS, listOf("sandbox", "ios")),
            Triple(ApnsEnvironment.PRODUCTION, AppPlatform.IOS, listOf("production", "ios")),
            Triple(ApnsEnvironment.PRODUCTION, AppPlatform.MACOS, listOf("production", "macos")),
        )
        for ((environment, platform, wire) in cases) {
            val recorder = Recorder { json(SUBSCRIPTION) }

            val id = assertIs<RepositoryResult.Content<String>>(
                HttpPushRepository(recorder.api).register("ab12", environment, platform),
            ).value

            assertEquals("5f0c8a52-0000-4000-8000-000000000001", id)
            val request = recorder.requests.single()
            assertEquals(HttpMethod.Post, request.method)
            assertEquals("/api/push-subscriptions", request.url.encodedPath)
            assertEquals("Bearer tok", request.headers["Authorization"])
            assertEquals(
                JsonObject(
                    mapOf(
                        "channel" to JsonPrimitive("apns"),
                        "platform" to JsonPrimitive(wire[1]),
                        "deviceToken" to JsonPrimitive("ab12"),
                        "apnsEnvironment" to JsonPrimitive(wire[0]),
                    ),
                ),
                recorder.bodyJson(),
            )
        }
    }

    @Test
    fun aRegistrationAnswerWithoutAnIdIsInvalidAndARefusalKeepsItsKind() = runTest {
        val answers = listOf(
            Recorder { json("""{"subscription":{"id":""}}""") } to FailureKind.INVALID_DATA,
            Recorder { json("""{"ok":true}""") } to FailureKind.INVALID_DATA,
            Recorder { json("""{"error":"bad"}""", HttpStatusCode.BadRequest) } to FailureKind.REJECTED,
        )
        for ((recorder, kind) in answers) {
            val result = HttpPushRepository(recorder.api).register("ab12", ApnsEnvironment.SANDBOX, AppPlatform.IOS)

            assertEquals(RepositoryResult.Failure(kind), result)
        }
    }

    @Test
    fun revokingPostsToTheSubscriptionsOwnRevokePath() = runTest {
        val recorder = Recorder { json("""{"revoked":true}""") }

        val result = HttpPushRepository(recorder.api).revoke("5f0c8a52-0000-4000-8000-000000000001")

        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(HttpMethod.Post, recorder.requests.single().method)
        assertEquals(
            "/api/push-subscriptions/5f0c8a52-0000-4000-8000-000000000001/revoke",
            recorder.requests.single().url.encodedPath,
        )
    }

    @Test
    fun remindersAreReadForTheWindowAndAnUnknownKindIsLeftOut() = runTest {
        val recorder = Recorder {
            json(
                """[
                {"key":"e1:2026-11-21T08:45:00.000Z","itemId":"e1","kind":"event","title":"Dinner",
                 "fireAt":"2026-11-21T08:45:00.000Z","startsAt":"2026-11-21T09:00:00.000Z"},
                {"key":"x1:2026-11-21T09:00:00.000Z","itemId":"x1","kind":"birthday","title":"Eva",
                 "fireAt":"2026-11-21T09:00:00.000Z","startsAt":"2026-11-21T09:00:00.000Z"},
                {"key":"t1:2026-11-21T10:00:00.000Z","itemId":"t1","kind":"task","title":"Call",
                 "fireAt":"2026-11-21T10:00:00.000Z","startsAt":"2026-11-21T10:00:00.000Z"}
                ]""",
            )
        }

        val reminders = assertIs<RepositoryResult.Content<List<UpcomingReminder>>>(
            HttpPushRepository(recorder.api).upcomingReminders("2026-11-21T08:00:00.000Z", 48),
        ).value

        val request = recorder.requests.single()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("/api/calendar/reminders", request.url.encodedPath)
        assertEquals("2026-11-21T08:00:00.000Z", request.url.parameters["from"])
        assertEquals("48", request.url.parameters["hours"])
        assertEquals(
            listOf(
                UpcomingReminder(
                    "e1:2026-11-21T08:45:00.000Z", "e1", ReminderKind.EVENT, "Dinner",
                    "2026-11-21T08:45:00.000Z", "2026-11-21T09:00:00.000Z",
                ),
                UpcomingReminder(
                    "t1:2026-11-21T10:00:00.000Z", "t1", ReminderKind.TASK, "Call",
                    "2026-11-21T10:00:00.000Z", "2026-11-21T10:00:00.000Z",
                ),
            ),
            reminders,
        )
    }

    @Test
    fun theBadgeCountsAreRead() = runTest {
        val recorder = Recorder { json("""{"pendingApprovals":3,"pendingInvites":2,"openInboxItems":0}""") }

        val counts = HttpPushRepository(recorder.api).badgeCounts()

        assertEquals(RepositoryResult.Content(BadgeCounts(3, 2, 0)), counts)
        assertEquals("/api/badge-counts", recorder.requests.single().url.encodedPath)
    }
}
