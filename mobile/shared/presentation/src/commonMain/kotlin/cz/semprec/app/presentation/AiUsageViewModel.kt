package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.AccountUsageGranularity
import cz.semprec.app.domain.AccountUsageLimits
import cz.semprec.app.domain.AccountUsageReport
import cz.semprec.app.domain.AccountUsageRepository
import cz.semprec.app.domain.IsoDate
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The AI spend of a period. [today] is `yyyy-MM-dd`, asked whenever a period is read. A newer choice supersedes the
 * read before it. The caps are read once next to the first report; a screen without them still shows the spend.
 */
class AiUsageViewModel internal constructor(
    private val usage: AccountUsageRepository,
    private val today: () -> String,
) : ScreenViewModel<AiUsageState, AiUsageAction, Nothing>(AiUsageState(periods = basePeriods(today()))) {
    private var loadJob: Job? = null

    init {
        load(UsagePeriod.Week)
        viewModelScope.launch {
            val result = answer { usage.limits() }
            ensureActive()
            if (result is Answer.Done) update { it.copy(caps = result.value.toCaps()) }
        }
    }

    override fun onAction(action: AiUsageAction) {
        if (isClosed) return
        when (action) {
            AiUsageAction.Retry -> load(state.value.period)
            is AiUsageAction.SelectPeriod ->
                if (action.period in state.value.periods) load(action.period)
            is AiUsageAction.PickPoint -> pick(action.index)
        }
    }

    private fun pick(index: Int) {
        if (index !in state.value.points.indices) return
        update { it.copy(picked = if (it.picked == index) null else index) }
    }

    private fun load(period: UsagePeriod) {
        loadJob?.cancel()
        val range = rangeOf(period, today())
        update { it.copy(phase = AiUsagePhase.LOADING, failure = null, period = period, picked = null) }
        loadJob = viewModelScope.launch {
            val result = answer { usage.report(range.from, range.to, range.granularity) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> it.withReport(result.value, today())
                    is Answer.Rejected -> it.copy(phase = AiUsagePhase.ERROR, failure = result.kind)
                }
            }
        }
    }
}

private data class UsageRange(val from: String, val to: String, val granularity: AccountUsageGranularity)

private const val WEEK_DAYS = 6
private const val ALL_FROM = "2000-01-01"
private const val MONTH_TEXT = 7

private fun basePeriods(today: String): List<UsagePeriod> =
    listOf(UsagePeriod.Week, UsagePeriod.All, UsagePeriod.Month(today.take(MONTH_TEXT)))

private fun rangeOf(period: UsagePeriod, today: String): UsageRange {
    val last = IsoDate.parse(today)
    return when (period) {
        UsagePeriod.Week ->
            UsageRange(last?.plusDays(-WEEK_DAYS)?.toString() ?: today, today, AccountUsageGranularity.DAY)
        UsagePeriod.All -> UsageRange(ALL_FROM, today, AccountUsageGranularity.MONTH)
        is UsagePeriod.Month -> {
            val first = IsoDate.parse("${period.month}-01")
            val end = first?.let { monthEnd(it) }
            val to = if (end != null && last != null && end > last) last.toString() else end?.toString() ?: today
            UsageRange(first?.toString() ?: today, to, AccountUsageGranularity.DAY)
        }
    }
}

/** The last day of the month that [first] opens. */
private fun monthEnd(first: IsoDate): IsoDate {
    var day = first.plusDays(MONTH_SKIP)
    while (day.month != first.month) day = day.plusDays(-1)
    return day
}

private const val MONTH_SKIP = 31

/** The months from the one the account started in to the one [today] is in, oldest first. */
private fun monthsBetween(startedAt: String, today: String): List<UsagePeriod> {
    val first = startedAt.take(MONTH_TEXT)
    val last = today.take(MONTH_TEXT)
    if (IsoDate.parse("$first-01") == null || first > last) return listOf(UsagePeriod.Month(last))
    val months = mutableListOf<UsagePeriod>()
    var day = IsoDate.parse("$first-01")
    while (day != null && day.toString().take(MONTH_TEXT) <= last) {
        months += UsagePeriod.Month(day.toString().take(MONTH_TEXT))
        day = day.plusDays(MONTH_SKIP).let { IsoDate.parse("${it.toString().take(MONTH_TEXT)}-01") }
    }
    return months
}

private fun AiUsageState.withReport(report: AccountUsageReport, today: String) = copy(
    phase = AiUsagePhase.CONTENT,
    periods = listOf(UsagePeriod.Week, UsagePeriod.All) + monthsBetween(report.accountStartedAt, today),
    accountStartedAt = report.accountStartedAt,
    totalUsd = report.totalCostUsd,
    estimated = report.estimated,
    points = report.points.map { UsagePointItem(it.key, it.costUsd) },
    models = report.models.map {
        UsageModelItem(it.name, it.costUsd, it.callCount, it.inputTokens, it.outputTokens, it.audioSeconds)
    },
    operations = report.operations.map { UsageOperationItem(it.label, it.costUsd, it.share, it.callCount) },
)

private fun AccountUsageLimits.toCaps() = UsageCaps(dailyCapUsd, monthlyCapUsd, exhausted)
