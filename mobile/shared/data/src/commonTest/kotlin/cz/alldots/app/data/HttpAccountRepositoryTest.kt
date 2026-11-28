package cz.alldots.app.data

import cz.alldots.app.core.AccountDeviceKind
import cz.alldots.app.core.AccountPlatform
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AccountDevice
import cz.alldots.app.domain.AccountSummary
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val SUMMARY = """{"activeSessions":4,"mailAccountCount":2,
    "mailAccountsNeedingReauth":[{"id":"m1","name":"Gmail"}],"trashItems":7,"trashDatabases":2,"problemCount":2,
    "aiCostMonthUsd":24.12}"""

private const val SESSIONS = """{"sessions":[
    {"id":"s1","current":true,"platform":"ios","deviceKind":"iphone","deviceName":"iPhone 17 Pro",
    "createdAt":"2026-10-01T10:00:00Z","lastSeenAt":"2026-10-21T10:00:00Z"},
    {"id":"s2","current":false,"platform":"macos","deviceKind":"mac","deviceName":" ",
    "createdAt":"2026-09-12T10:00:00Z","lastSeenAt":"2026-10-21T08:00:00Z"},
    {"id":"s3","current":false,"platform":"web","deviceKind":"browser","deviceName":"Safari",
    "createdAt":"2026-10-03T10:00:00Z","lastSeenAt":"2026-10-20T21:14:00Z"},
    {"id":"s4","current":false,"platform":"ios","deviceKind":"ipad","deviceName":null,
    "createdAt":"2026-06-01T10:00:00Z","lastSeenAt":"2026-10-09T10:00:00Z"},
    {"id":"s5","current":false,"platform":"other","deviceKind":null,
    "createdAt":"2026-06-01T10:00:00Z","lastSeenAt":"2026-10-09T10:00:00Z"}]}"""

class HttpAccountRepositoryTest {
    private fun recorder(status: HttpStatusCode = HttpStatusCode.OK, body: String = "{}") =
        Recorder { json(body, status) }

    @Test
    fun theSummaryCountsWhatTheRowsOfTheProfileShow() = runTest {
        val recorder = recorder(body = SUMMARY)

        val result = HttpAccountRepository(recorder.api).summary()

        assertEquals(HttpMethod.Get, recorder.requests.single().method)
        assertEquals("/api/account/summary", recorder.requests.single().url.encodedPath)
        assertEquals(
            AccountSummary(4, 2, 1, 7, 2, 2, 24.12),
            assertIs<RepositoryResult.Content<AccountSummary>>(result).value,
        )
    }

    @Test
    fun theDevicesSayWhichSessionIsThisOneAndNameTheKindsTheServerKnows() = runTest {
        val devices = assertIs<RepositoryResult.Content<List<AccountDevice>>>(
            HttpAccountRepository(recorder(body = SESSIONS).api).devices(),
        ).value

        assertEquals(listOf("s1", "s2", "s3", "s4", "s5"), devices.map { it.id })
        assertEquals(listOf(true, false, false, false, false), devices.map { it.current })
        assertEquals(
            listOf(
                AccountPlatform.IOS,
                AccountPlatform.MACOS,
                AccountPlatform.WEB,
                AccountPlatform.IOS,
                AccountPlatform.UNKNOWN,
            ),
            devices.map { it.platform },
        )
        assertEquals(
            listOf(
                AccountDeviceKind.IPHONE,
                AccountDeviceKind.MAC,
                AccountDeviceKind.BROWSER,
                AccountDeviceKind.IPAD,
                AccountDeviceKind.UNKNOWN,
            ),
            devices.map { it.kind },
        )
        assertEquals(listOf("iPhone 17 Pro", null, "Safari", null, null), devices.map { it.name })
        assertEquals("2026-10-21T10:00:00Z", devices[0].lastSeenAt)
    }

    @Test
    fun revokingADevicePostsToItsOwnRevokePath() = runTest {
        val recorder = recorder(body = """{"revoked":true}""")

        val result = HttpAccountRepository(recorder.api).revokeDevice("s2")

        assertIs<RepositoryResult.Content<Unit>>(result)
        assertEquals(HttpMethod.Post, recorder.requests.single().method)
        assertEquals("/api/auth/sessions/s2/revoke", recorder.requests.single().url.encodedPath)
    }

    @Test
    fun revokingTheOthersPostsToTheRevokeOthersPath() = runTest {
        val recorder = recorder(body = """{"revokedCount":3}""")

        assertIs<RepositoryResult.Content<Unit>>(HttpAccountRepository(recorder.api).revokeOtherDevices())

        assertEquals(HttpMethod.Post, recorder.requests.single().method)
        assertEquals("/api/auth/sessions/revoke-others", recorder.requests.single().url.encodedPath)
    }

    @Test
    fun changingTheLanguagePatchesTheProfileWithTheLocale() = runTest {
        val recorder = recorder(body = """{"user":{}}""")

        assertIs<RepositoryResult.Content<Unit>>(HttpAccountRepository(recorder.api).changeLocale("en"))

        assertEquals(HttpMethod.Patch, recorder.requests.single().method)
        assertEquals("/api/account/profile", recorder.requests.single().url.encodedPath)
        assertEquals("en", recorder.bodyJson().getValue("locale").jsonPrimitive.content)
    }

    @Test
    fun aRefusedRequestIsAFailureOfItsKindAndAnUnreadableAnswerIsInvalidData() = runTest {
        val refused = HttpAccountRepository(recorder(HttpStatusCode.BadRequest).api).changeLocale("xx")
        val broken = HttpAccountRepository(recorder(body = "[]").api).summary()
        val unavailable = HttpAccountRepository(recorder(HttpStatusCode.ServiceUnavailable).api).devices()

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refused)
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), broken)
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), unavailable)
    }

    @Test
    fun anExpiredSessionIsReportedAndIsUnauthorized() = runTest {
        val recorder = recorder(HttpStatusCode.Unauthorized)

        val result = HttpAccountRepository(recorder.api).revokeDevice("s2")

        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), result)
        assertEquals(1, recorder.rejected)
    }
}
