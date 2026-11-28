package cz.alldots.app.data

import cz.alldots.app.core.AccountNotificationSwitch
import cz.alldots.app.core.AccountProblemsLevel
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AccountNotificationPrefs
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val PREFS = """{"approvals":true,"invites":false,"reminders":true,"calendarChanges":false,
    "problemsLevel":"all",
    "problemsSummary":false,"badgeApprovals":true,"badgeInvites":false,"badgeInbox":true,
    "updatedAt":"2026-10-21T10:00:00Z"}"""

class HttpAccountNotificationRepositoryTest {
    private fun recorder(status: HttpStatusCode = HttpStatusCode.OK, body: String = PREFS) =
        Recorder { json(body, status) }

    @Test
    fun theStoredPreferencesAreRead() = runTest {
        val recorder = recorder()

        val prefs = assertIs<RepositoryResult.Content<AccountNotificationPrefs>>(
            HttpAccountNotificationRepository(recorder.api).load(),
        ).value

        assertEquals(HttpMethod.Get, recorder.requests.single().method)
        assertEquals("/api/notification-preferences", recorder.requests.single().url.encodedPath)
        assertEquals(
            AccountNotificationPrefs(true, false, true, false, AccountProblemsLevel.ALL, false, true, false, true),
            prefs,
        )
    }

    @Test
    fun everyProblemLevelIsReadAndAnUnknownOneIsTheDefault() = runTest {
        suspend fun level(wire: String) = assertIs<RepositoryResult.Content<AccountNotificationPrefs>>(
            runTestRead("""{"problemsLevel":"$wire"}"""),
        ).value.problemsLevel

        assertEquals(AccountProblemsLevel.OFF, level("off"))
        assertEquals(AccountProblemsLevel.CRITICAL, level("critical"))
        assertEquals(AccountProblemsLevel.ALL, level("all"))
        assertEquals(AccountProblemsLevel.CRITICAL, level("future"))
    }

    @Test
    fun calendarChangesAreOnWhenTheServerLeavesThemOut() = runTest {
        val prefs = assertIs<RepositoryResult.Content<AccountNotificationPrefs>>(runTestRead("{}")).value

        assertEquals(true, prefs.calendarChanges)
    }

    @Test
    fun eachSwitchIsPatchedUnderItsOwnName() = runTest {
        val names = mapOf(
            AccountNotificationSwitch.APPROVALS to "approvals",
            AccountNotificationSwitch.INVITES to "invites",
            AccountNotificationSwitch.REMINDERS to "reminders",
            AccountNotificationSwitch.CALENDAR_CHANGES to "calendarChanges",
            AccountNotificationSwitch.PROBLEMS_SUMMARY to "problemsSummary",
            AccountNotificationSwitch.BADGE_APPROVALS to "badgeApprovals",
            AccountNotificationSwitch.BADGE_INVITES to "badgeInvites",
            AccountNotificationSwitch.BADGE_INBOX to "badgeInbox",
        )
        for ((switch, name) in names) {
            val recorder = recorder()

            assertIs<RepositoryResult.Content<AccountNotificationPrefs>>(
                HttpAccountNotificationRepository(recorder.api).setSwitch(switch, on = false),
            )

            assertEquals(HttpMethod.Patch, recorder.requests.single().method)
            assertEquals(JsonObject(mapOf(name to JsonPrimitive(false))), recorder.bodyJson())
        }
    }

    @Test
    fun theProblemLevelIsPatchedAsItsWireName() = runTest {
        val wire = mapOf(
            AccountProblemsLevel.OFF to "off",
            AccountProblemsLevel.CRITICAL to "critical",
            AccountProblemsLevel.ALL to "all",
        )
        for ((level, name) in wire) {
            val recorder = recorder()

            HttpAccountNotificationRepository(recorder.api).setProblemsLevel(level)

            assertEquals(JsonObject(mapOf("problemsLevel" to JsonPrimitive(name))), recorder.bodyJson())
        }
    }

    @Test
    fun aRefusedPatchAndAnUnreadableAnswerAreFailuresOfTheirKind() = runTest {
        val refused = HttpAccountNotificationRepository(recorder(HttpStatusCode.BadRequest).api)
            .setSwitch(AccountNotificationSwitch.INVITES, on = true)
        val broken = HttpAccountNotificationRepository(recorder(body = "[]").api).load()

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refused)
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), broken)
    }

    private suspend fun runTestRead(body: String): RepositoryResult<AccountNotificationPrefs> =
        HttpAccountNotificationRepository(recorder(body = body).api).load()
}
