package cz.semprec.app.data

import cz.semprec.app.core.AccountUsageGranularity
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AccountUsageLimits
import cz.semprec.app.domain.AccountUsageReport
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val REPORT = """{"accountStartedAt":"2026-06-03T08:00:00.000Z","timezone":"Europe/Prague",
    "from":"2026-10-15T00:00:00.000Z","to":"2026-10-22T00:00:00.000Z","rows":[],"estimated":true,
    "totalCostUsd":24.12,
    "dailyCostUsd":[{"day":"2026-10-20","costUsd":1.5},{"day":"2026-10-21","costUsd":2.25}],
    "dailyTokenUsage":[],
    "monthlyCostUsd":[{"month":"2026-09","costUsd":9.5},{"month":"2026-10","costUsd":14.62}],
    "byModel":[{"provider":"anthropic","model":"claude-sonnet","displayName":"Claude Sonnet","callCount":820,
    "costUsd":14,"inputTokens":3000000,"outputTokens":900000,"audioSeconds":null,"operations":["chat"]},
    {"provider":"openai","model":"whisper-1","displayName":"","callCount":3,"costUsd":4.3,"inputTokens":null,
    "outputTokens":null,"audioSeconds":8040.5,"operations":[]}],
    "byOperation":[{"operation":"chat","label":"Semp chat","costUsd":15,"share":0.62,"callCount":900}],
    "budgets":{"dailyBudgetUsd":50,"monthlyBudgetUsd":40}}"""

private const val LIMITS = """{"hasBudget":true,"spentTodayUsd":2.25,"spentMonthUsd":14.62,"dailyCapUsd":50,
    "monthlyCapUsd":null,"exhausted":"daily","resetsAt":"2026-10-22T00:00:00.000Z"}"""

class HttpAccountUsageRepositoryTest {
    private fun recorder(status: HttpStatusCode = HttpStatusCode.OK, body: String = REPORT) =
        Recorder { json(body, status) }

    @Test
    fun aDailyReportAsksForTheDaysAndTheEndIsTheStartOfTheDayAfter() = runTest {
        val recorder = recorder()

        val report = assertIs<RepositoryResult.Content<AccountUsageReport>>(
            HttpAccountUsageRepository(recorder.api).report("2026-10-15", "2026-10-21", AccountUsageGranularity.DAY),
        ).value

        val url = recorder.requests.single().url
        assertEquals("/api/ai-usage", url.encodedPath)
        assertEquals("2026-10-15T00:00:00Z", url.parameters["from"])
        assertEquals("2026-10-22T00:00:00Z", url.parameters["to"])
        assertEquals("day", url.parameters["granularity"])
        assertEquals(listOf("2026-10-20", "2026-10-21"), report.points.map { it.key })
        assertEquals(listOf(1.5, 2.25), report.points.map { it.costUsd })
        assertEquals(24.12, report.totalCostUsd)
        assertTrue(report.estimated)
        assertEquals("2026-06-03T08:00:00.000Z", report.accountStartedAt)
    }

    @Test
    fun aMonthlyReportUsesTheMonthlySeries() = runTest {
        val recorder = recorder()

        val report = assertIs<RepositoryResult.Content<AccountUsageReport>>(
            HttpAccountUsageRepository(recorder.api).report("2000-01-01", "2026-10-21", AccountUsageGranularity.MONTH),
        ).value

        assertEquals("month", recorder.requests.single().url.parameters["granularity"])
        assertEquals(listOf("2026-09", "2026-10"), report.points.map { it.key })
        assertEquals(AccountUsageGranularity.MONTH, report.granularity)
    }

    @Test
    fun aMonthlyAnswerWithoutTheSeriesHasNoPoints() = runTest {
        val report = assertIs<RepositoryResult.Content<AccountUsageReport>>(
            HttpAccountUsageRepository(recorder(body = """{"totalCostUsd":0}""").api)
                .report("2000-01-01", "2026-10-21", AccountUsageGranularity.MONTH),
        ).value

        assertTrue(report.points.isEmpty())
    }

    @Test
    fun theModelsAndTheKindsOfWorkCarryTheirUnitsAndLabels() = runTest {
        val report = assertIs<RepositoryResult.Content<AccountUsageReport>>(
            HttpAccountUsageRepository(recorder().api).report("2026-10-15", "2026-10-21", AccountUsageGranularity.DAY),
        ).value

        assertEquals(listOf("Claude Sonnet", "whisper-1"), report.models.map { it.name })
        assertEquals(3_000_000L, report.models[0].inputTokens)
        assertNull(report.models[0].audioSeconds)
        assertEquals(8040.5, report.models[1].audioSeconds)
        assertNull(report.models[1].inputTokens)
        assertEquals("Semp chat", report.operations.single().label)
        assertEquals(0.62, report.operations.single().share)
    }

    @Test
    fun aDayThatIsNoDateIsInvalidDataAndAsksNothing() = runTest {
        val recorder = recorder()

        val result = HttpAccountUsageRepository(recorder.api).report("2026-10-15", "soon", AccountUsageGranularity.DAY)

        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), result)
        assertTrue(recorder.requests.isEmpty())
    }

    @Test
    fun theLimitsKeepAMissingCapAsNullAndSayWhenOneIsReached() = runTest {
        val recorder = recorder(body = LIMITS)

        val limits = assertIs<RepositoryResult.Content<AccountUsageLimits>>(
            HttpAccountUsageRepository(recorder.api).limits(),
        ).value

        assertEquals("/api/ai-usage/summary", recorder.requests.single().url.encodedPath)
        assertEquals(AccountUsageLimits(2.25, 14.62, 50.0, null, exhausted = true), limits)
    }

    @Test
    fun limitsWithNoCapReachedAreNotExhaustedAndFailuresKeepTheirKind() = runTest {
        val free = assertIs<RepositoryResult.Content<AccountUsageLimits>>(
            HttpAccountUsageRepository(recorder(body = """{"hasBudget":false,"exhausted":null}""").api).limits(),
        ).value
        val down = HttpAccountUsageRepository(recorder(HttpStatusCode.ServiceUnavailable).api).limits()

        assertEquals(false, free.exhausted)
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), down)
    }
}
