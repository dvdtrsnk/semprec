package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class AiUsagePhase { LOADING, CONTENT, ERROR }

/** The time the spend is shown for: the last seven days, the whole account, or one calendar month (`2026-10`). */
sealed interface UsagePeriod {
    data object Week : UsagePeriod
    data object All : UsagePeriod
    data class Month(val month: String) : UsagePeriod
}

/** The cost of one bar: a day (`2026-10-21`) or, for the whole account, a month (`2026-10`). */
data class UsagePointItem(val key: String, val costUsd: Double)

data class UsageModelItem(
    val name: String,
    val costUsd: Double,
    val callCount: Int,
    val inputTokens: Long?,
    val outputTokens: Long?,
    val audioSeconds: Double?,
)

data class UsageOperationItem(val label: String, val costUsd: Double, val share: Double, val callCount: Int)

/** The caps of the server. A cap that is not set is `null`; [exhausted] is true when one is reached. */
data class UsageCaps(val dailyUsd: Double?, val monthlyUsd: Double?, val exhausted: Boolean)

/**
 * The AI spend. [periods] lists what can be chosen (the months run from the start of the account to this one);
 * [picked] is the index of the bar the person tapped. [caps] is `null` until the caps arrive or when they cannot be
 * read: the spend does not depend on them.
 */
data class AiUsageState(
    val phase: AiUsagePhase = AiUsagePhase.LOADING,
    val failure: FailureKind? = null,
    val periods: List<UsagePeriod> = emptyList(),
    val period: UsagePeriod = UsagePeriod.Week,
    val accountStartedAt: String? = null,
    val totalUsd: Double = 0.0,
    val estimated: Boolean = false,
    val points: List<UsagePointItem> = emptyList(),
    val models: List<UsageModelItem> = emptyList(),
    val operations: List<UsageOperationItem> = emptyList(),
    val caps: UsageCaps? = null,
    val picked: Int? = null,
)

sealed interface AiUsageAction {
    data object Retry : AiUsageAction

    data class SelectPeriod(val period: UsagePeriod) : AiUsageAction

    /** Marks the bar at [index], or clears the mark when it is the one marked; an index with no bar is ignored. */
    data class PickPoint(val index: Int) : AiUsageAction
}
