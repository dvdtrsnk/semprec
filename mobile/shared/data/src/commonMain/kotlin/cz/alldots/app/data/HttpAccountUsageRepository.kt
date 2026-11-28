package cz.alldots.app.data

import cz.alldots.app.core.AccountUsageGranularity
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AccountUsageLimits
import cz.alldots.app.domain.AccountUsageModel
import cz.alldots.app.domain.AccountUsageOperation
import cz.alldots.app.domain.AccountUsagePoint
import cz.alldots.app.domain.AccountUsageReport
import cz.alldots.app.domain.AccountUsageRepository
import cz.alldots.app.domain.IsoDate
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod

/**
 * The AI spend: `GET /api/ai-usage` for a period and `GET /api/ai-usage/summary` for the caps. The server reads the
 * range as instants and excludes the end, so the last day is sent as the start of the day after it.
 */
class HttpAccountUsageRepository(private val api: AuthenticatedApi) : AccountUsageRepository {

    override suspend fun report(
        from: String,
        to: String,
        granularity: AccountUsageGranularity,
    ): RepositoryResult<AccountUsageReport> {
        val last = IsoDate.parse(to) ?: return RepositoryResult.Failure(FailureKind.INVALID_DATA)
        val query = listOf(
            "from" to "${from}T00:00:00Z",
            "to" to "${last.plusDays(1)}T00:00:00Z",
            "granularity" to if (granularity == AccountUsageGranularity.MONTH) "month" else "day",
        )
        return api.send(HttpMethod.Get, "/api/ai-usage", query).decode<AccountUsageReportDto>()
            .map { it.toReport(granularity) }
    }

    override suspend fun limits(): RepositoryResult<AccountUsageLimits> =
        api.send(HttpMethod.Get, "/api/ai-usage/summary").decode<AccountUsageLimitsDto>().map { dto ->
            AccountUsageLimits(
                spentTodayUsd = dto.spentTodayUsd,
                spentMonthUsd = dto.spentMonthUsd,
                dailyCapUsd = dto.dailyCapUsd,
                monthlyCapUsd = dto.monthlyCapUsd,
                exhausted = dto.exhausted != null,
            )
        }
}

private fun AccountUsageReportDto.toReport(granularity: AccountUsageGranularity) = AccountUsageReport(
    granularity = granularity,
    accountStartedAt = accountStartedAt,
    totalCostUsd = totalCostUsd,
    estimated = estimated,
    points = when (granularity) {
        AccountUsageGranularity.DAY -> dailyCostUsd.map { AccountUsagePoint(it.day, it.costUsd) }
        AccountUsageGranularity.MONTH -> monthlyCostUsd.orEmpty().map { AccountUsagePoint(it.month, it.costUsd) }
    },
    models = byModel.map {
        AccountUsageModel(
            name = it.displayName.ifBlank { it.model },
            costUsd = it.costUsd,
            callCount = it.callCount,
            inputTokens = it.inputTokens,
            outputTokens = it.outputTokens,
            audioSeconds = it.audioSeconds,
        )
    },
    operations = byOperation.map { AccountUsageOperation(it.label, it.costUsd, it.share, it.callCount) },
)
