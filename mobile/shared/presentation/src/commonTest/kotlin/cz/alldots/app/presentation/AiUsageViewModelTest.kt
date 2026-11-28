package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.AccountUsageGranularity
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AccountUsageLimits
import cz.alldots.app.domain.AccountUsageModel
import cz.alldots.app.domain.AccountUsageOperation
import cz.alldots.app.domain.AccountUsagePoint
import cz.alldots.app.domain.AccountUsageReport
import cz.alldots.app.domain.AccountUsageRepository
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val AI_USAGE_TODAY = "2026-10-21"

private val REPORT = AccountUsageReport(
    granularity = AccountUsageGranularity.DAY,
    accountStartedAt = "2026-08-03T08:00:00.000Z",
    totalCostUsd = 24.12,
    estimated = true,
    points = listOf(AccountUsagePoint("2026-10-20", 1.5), AccountUsagePoint("2026-10-21", 2.25)),
    models = listOf(AccountUsageModel("Claude Sonnet", 14.0, 820, 3_000_000, 900_000, null)),
    operations = listOf(AccountUsageOperation("Semp chat", 15.0, 0.62, 900)),
)

private val LIMITS = AccountUsageLimits(2.25, 14.62, 50.0, 40.0, exhausted = false)

private data class AskedReport(val from: String, val to: String, val granularity: AccountUsageGranularity)

private class ScriptedUsage(
    reports: List<ScriptedStep<AccountUsageReport>> = listOf({ RepositoryResult.Content(REPORT) }),
    limits: List<ScriptedStep<AccountUsageLimits>> = listOf({ RepositoryResult.Content(LIMITS) }),
) : AccountUsageRepository {
    val reportCalls = CallScript(reports)
    val limitCalls = CallScript(limits)
    val asked = mutableListOf<AskedReport>()

    override suspend fun report(
        from: String,
        to: String,
        granularity: AccountUsageGranularity,
    ): RepositoryResult<AccountUsageReport> {
        asked += AskedReport(from, to, granularity)
        return reportCalls.next()
    }

    override suspend fun limits() = limitCalls.next()
}

@OptIn(ExperimentalCoroutinesApi::class)
class AiUsageViewModelTest : MainDispatcherTest() {
    private fun viewModel(usage: ScriptedUsage, today: () -> String = { AI_USAGE_TODAY }) =
        AccountViewModelFactory(
            AccountUnusedAccount,
            AccountUnusedNotifications,
            usage,
            AccountUnusedTrash,
            FakeAuthRepository(),
        ).aiUsageViewModel(today)

    private fun months(vararg months: String) = months.map { UsagePeriod.Month(it) }

    @Test fun `starts on the last seven days with the periods the account has lived through`() =
        runTest(dispatcher) {
            val usage = ScriptedUsage()
            val vm = viewModel(usage)
            assertEquals(AiUsagePhase.LOADING, vm.state.value.phase)
            val initial = listOf(UsagePeriod.Week, UsagePeriod.All, UsagePeriod.Month("2026-10"))
            assertEquals(initial, vm.state.value.periods)
            runCurrent()
            assertEquals(listOf(AskedReport("2026-10-15", AI_USAGE_TODAY, AccountUsageGranularity.DAY)), usage.asked)
            val state = vm.state.value
            assertEquals(AiUsagePhase.CONTENT, state.phase)
            assertEquals(UsagePeriod.Week, state.period)
            assertEquals(
                listOf(UsagePeriod.Week, UsagePeriod.All) + months("2026-08", "2026-09", "2026-10"),
                state.periods,
            )
            assertEquals(24.12, state.totalUsd)
            assertTrue(state.estimated)
            assertEquals(listOf(UsagePointItem("2026-10-20", 1.5), UsagePointItem("2026-10-21", 2.25)), state.points)
            assertEquals(UsageModelItem("Claude Sonnet", 14.0, 820, 3_000_000, 900_000, null), state.models.single())
            assertEquals(UsageOperationItem("Semp chat", 15.0, 0.62, 900), state.operations.single())
            assertEquals(UsageCaps(50.0, 40.0, false), state.caps)
            vm.close()
        }

    @Test fun `a month asks for its days up to today and an earlier month up to its last day`() = runTest(dispatcher) {
        val usage = ScriptedUsage()
        val vm = viewModel(usage)
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.Month("2026-10")))
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.Month("2026-09")))
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.Month("2026-08")))
        runCurrent()
        assertEquals(
            listOf(
                AskedReport("2026-10-01", AI_USAGE_TODAY, AccountUsageGranularity.DAY),
                AskedReport("2026-09-01", "2026-09-30", AccountUsageGranularity.DAY),
                AskedReport("2026-08-01", "2026-08-31", AccountUsageGranularity.DAY),
            ),
            usage.asked.drop(1),
        )
        vm.close()
    }

    @Test fun `February ends on its own last day`() = runTest(dispatcher) {
        val usage = ScriptedUsage(
            reports = listOf({ RepositoryResult.Content(REPORT.copy(accountStartedAt = "2026-02-10T00:00:00Z")) }),
        )
        val vm = viewModel(usage)
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.Month("2026-02")))
        runCurrent()
        assertEquals(AskedReport("2026-02-01", "2026-02-28", AccountUsageGranularity.DAY), usage.asked.last())
        vm.close()
    }

    @Test fun `the whole account is cut by month from the beginning of time to today`() = runTest(dispatcher) {
        val usage = ScriptedUsage()
        val vm = viewModel(usage)
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.All))
        runCurrent()
        assertEquals(AskedReport("2000-01-01", AI_USAGE_TODAY, AccountUsageGranularity.MONTH), usage.asked.last())
        assertEquals(UsagePeriod.All, vm.state.value.period)
        vm.close()
    }

    @Test fun `a period that is not offered is ignored`() = runTest(dispatcher) {
        val usage = ScriptedUsage()
        val vm = viewModel(usage)
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.Month("2020-01")))
        runCurrent()
        assertEquals(1, usage.reportCalls.calls)
        vm.close()
    }

    @Test fun `an account that started this month has this month only and a start in the future too`() =
        runTest(dispatcher) {
            val here = ScriptedUsage(
                reports = listOf({ RepositoryResult.Content(REPORT.copy(accountStartedAt = "2026-10-03T00:00:00Z")) }),
            )
            val first = viewModel(here)
            runCurrent()
            assertEquals(listOf(UsagePeriod.Week, UsagePeriod.All) + months("2026-10"), first.state.value.periods)
            first.close()

            val future = ScriptedUsage(
                reports = listOf({ RepositoryResult.Content(REPORT.copy(accountStartedAt = "2027-01-01T00:00:00Z")) }),
            )
            val second = viewModel(future)
            runCurrent()
            assertEquals(listOf(UsagePeriod.Week, UsagePeriod.All) + months("2026-10"), second.state.value.periods)
            second.close()
        }

    @Test fun `a bar is marked once and unmarked by tapping it again and a change of period forgets it`() =
        runTest(dispatcher) {
            val vm = viewModel(ScriptedUsage())
            runCurrent()
            vm.onAction(AiUsageAction.PickPoint(1))
            assertEquals(1, vm.state.value.picked)
            vm.onAction(AiUsageAction.PickPoint(0))
            assertEquals(0, vm.state.value.picked)
            vm.onAction(AiUsageAction.PickPoint(0))
            assertNull(vm.state.value.picked)
            vm.onAction(AiUsageAction.PickPoint(5))
            vm.onAction(AiUsageAction.PickPoint(-1))
            assertNull(vm.state.value.picked)
            vm.onAction(AiUsageAction.PickPoint(1))
            vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.All))
            assertNull(vm.state.value.picked)
            vm.close()
        }

    @Test fun `a failed report is an error with its kind and retry asks for the same period again`() =
        runTest(dispatcher) {
            val usage = ScriptedUsage(
                reports = listOf(
                    { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
                    { RepositoryResult.Content(REPORT) },
                ),
            )
            val vm = viewModel(usage)
            runCurrent()
            assertEquals(AiUsagePhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
            vm.onAction(AiUsageAction.Retry)
            assertEquals(AiUsagePhase.LOADING, vm.state.value.phase)
            runCurrent()
            assertEquals(AiUsagePhase.CONTENT, vm.state.value.phase)
            assertNull(vm.state.value.failure)
            assertEquals(usage.asked[0], usage.asked[1])
            vm.close()
        }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedUsage(reports = listOf(crashes())))
        runCurrent()
        assertEquals(AiUsagePhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `the spend is shown without caps when they cannot be read`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedUsage(limits = listOf({ RepositoryResult.Failure(FailureKind.UNAVAILABLE) })))
        runCurrent()
        assertEquals(AiUsagePhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.caps)
        vm.close()
    }

    @Test fun `a newer choice cancels the read before it and a late answer is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val stale = REPORT.copy(totalCostUsd = 99.0)
        val usage = ScriptedUsage(
            reports = listOf(answersLate(gate, RepositoryResult.Content(stale)), { RepositoryResult.Content(REPORT) }),
        )
        val vm = viewModel(usage)
        runCurrent()
        vm.onAction(AiUsageAction.SelectPeriod(UsagePeriod.All))
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(24.12, vm.state.value.totalUsd)
        assertEquals(UsagePeriod.All, vm.state.value.period)
        vm.close()
    }

    @Test fun `closing cancels the read and ignores later actions and clearing the store does the same`() =
        runTest(dispatcher) {
            val usage = ScriptedUsage(reports = listOf(neverAnswers()))
            val vm = viewModel(usage)
            runCurrent()
            vm.close()
            runCurrent()
            assertEquals(1, usage.reportCalls.cancellations)
            vm.onAction(AiUsageAction.Retry)
            runCurrent()
            assertEquals(1, usage.reportCalls.calls)

            val stored = ScriptedUsage(reports = listOf(neverAnswers()))
            val store = ViewModelStore()
            val owned = store.provide {
                AccountViewModelFactory(
                    AccountUnusedAccount,
                    AccountUnusedNotifications,
                    stored,
                    AccountUnusedTrash,
                    FakeAuthRepository(),
                ).aiUsageViewModel { AI_USAGE_TODAY }
            }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(owned.isClosed)
            assertEquals(1, stored.reportCalls.cancellations)
        }
}
