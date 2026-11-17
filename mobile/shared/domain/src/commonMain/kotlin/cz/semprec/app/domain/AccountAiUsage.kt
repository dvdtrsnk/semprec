package cz.semprec.app.domain

import cz.semprec.app.core.AccountUsageGranularity

/** The cost of one day (`2026-10-21`) or one month (`2026-10`); [key] is that text. */
data class AccountUsagePoint(val key: String, val costUsd: Double)

/** What one model cost. The units that do not apply to a model are `null`. */
data class AccountUsageModel(
    val name: String,
    val costUsd: Double,
    val callCount: Int,
    val inputTokens: Long?,
    val outputTokens: Long?,
    val audioSeconds: Double?,
)

/** What one kind of work cost, with the server's own label for it; [share] is a fraction of the total. */
data class AccountUsageOperation(val label: String, val costUsd: Double, val share: Double, val callCount: Int)

/** The AI spend of a period. [estimated] is true when a price in it is an estimate. */
data class AccountUsageReport(
    val granularity: AccountUsageGranularity,
    val accountStartedAt: String,
    val totalCostUsd: Double,
    val estimated: Boolean,
    val points: List<AccountUsagePoint>,
    val models: List<AccountUsageModel>,
    val operations: List<AccountUsageOperation>,
)

/** The spend of today and this month against the caps of the server; a missing cap is `null`, never 0. */
data class AccountUsageLimits(
    val spentTodayUsd: Double,
    val spentMonthUsd: Double,
    val dailyCapUsd: Double?,
    val monthlyCapUsd: Double?,
    val exhausted: Boolean,
)

interface AccountUsageRepository {
    /** The report for the days `from` to `to` (`yyyy-MM-dd`, both included), cut as [granularity] says. */
    suspend fun report(
        from: String,
        to: String,
        granularity: AccountUsageGranularity,
    ): RepositoryResult<AccountUsageReport>

    suspend fun limits(): RepositoryResult<AccountUsageLimits>
}
