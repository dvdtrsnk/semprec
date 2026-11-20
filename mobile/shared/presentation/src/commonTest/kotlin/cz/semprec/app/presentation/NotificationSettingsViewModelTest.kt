package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.AccountNotificationSwitch
import cz.semprec.app.core.AccountProblemsLevel
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AccountNotificationPrefs
import cz.semprec.app.domain.AccountNotificationRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val STORED = AccountNotificationPrefs(
    approvals = true,
    invites = true,
    reminders = true,
    problemsLevel = AccountProblemsLevel.CRITICAL,
    problemsSummary = true,
    badgeApprovals = true,
    badgeInvites = true,
    badgeInbox = false,
)

private val CHOICES = NotificationChoices(
    approvals = true,
    invites = true,
    reminders = true,
    problemsLevel = AccountProblemsLevel.CRITICAL,
    problemsSummary = true,
    badgeApprovals = true,
    badgeInvites = true,
    badgeInbox = false,
)

private class ScriptedPrefs(
    load: List<ScriptedStep<AccountNotificationPrefs>> = listOf({ RepositoryResult.Content(STORED) }),
    private val write: ScriptedStep<AccountNotificationPrefs> = { RepositoryResult.Content(STORED) },
) : AccountNotificationRepository {
    val loads = CallScript(load)
    val switches = mutableListOf<Pair<AccountNotificationSwitch, Boolean>>()
    val levels = mutableListOf<AccountProblemsLevel>()

    override suspend fun load() = loads.next()

    override suspend fun setSwitch(
        switch: AccountNotificationSwitch,
        on: Boolean,
    ): RepositoryResult<AccountNotificationPrefs> {
        switches += switch to on
        return write()
    }

    override suspend fun setProblemsLevel(level: AccountProblemsLevel): RepositoryResult<AccountNotificationPrefs> {
        levels += level
        return write()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class NotificationSettingsViewModelTest : MainDispatcherTest() {
    private fun viewModel(prefs: ScriptedPrefs) =
        AccountViewModelFactory(
            AccountUnusedAccount,
            prefs,
            AccountUnusedUsage,
            AccountUnusedTrash,
            FakeAuthRepository(),
        ).notificationSettingsViewModel()

    @Test fun `loads what the server holds`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedPrefs())
        assertEquals(NotificationSettingsState(), vm.state.value)
        runCurrent()
        assertEquals(NotificationSettingsState(NotificationSettingsPhase.CONTENT, null, CHOICES), vm.state.value)
        vm.close()
    }

    @Test fun `a failed load is an error with its kind and retry loads again`() = runTest(dispatcher) {
        val prefs = ScriptedPrefs(
            load = listOf({ RepositoryResult.Failure(FailureKind.UNAUTHORIZED) }, { RepositoryResult.Content(STORED) }),
        )
        val vm = viewModel(prefs)
        runCurrent()
        val error = NotificationSettingsState(NotificationSettingsPhase.ERROR, FailureKind.UNAUTHORIZED)
        assertEquals(error, vm.state.value)
        vm.onAction(NotificationSettingsAction.Retry)
        assertEquals(NotificationSettingsState(), vm.state.value)
        runCurrent()
        assertEquals(CHOICES, vm.state.value.choices)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedPrefs(load = listOf(crashes())))
        runCurrent()
        assertEquals(NotificationSettingsState(NotificationSettingsPhase.ERROR, null), vm.state.value)
        vm.close()
    }

    @Test fun `a switch shows at once and keeps what the server answers`() = runTest(dispatcher) {
        val answer = STORED.copy(invites = false, badgeInbox = true)
        val prefs = ScriptedPrefs(write = { RepositoryResult.Content(answer) })
        val vm = viewModel(prefs)
        runCurrent()
        vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.INVITES, on = false))
        assertEquals(false, vm.state.value.choices?.invites)
        runCurrent()
        assertEquals(listOf(AccountNotificationSwitch.INVITES to false), prefs.switches)
        assertEquals(false, vm.state.value.choices?.invites)
        assertEquals(true, vm.state.value.choices?.badgeInbox)
        vm.close()
    }

    @Test fun `every switch changes its own value`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedPrefs(write = { error("unexpected") }))
        runCurrent()
        val reads: Map<AccountNotificationSwitch, (NotificationChoices) -> Boolean> = mapOf(
            AccountNotificationSwitch.APPROVALS to { it.approvals },
            AccountNotificationSwitch.INVITES to { it.invites },
            AccountNotificationSwitch.REMINDERS to { it.reminders },
            AccountNotificationSwitch.PROBLEMS_SUMMARY to { it.problemsSummary },
            AccountNotificationSwitch.BADGE_APPROVALS to { it.badgeApprovals },
            AccountNotificationSwitch.BADGE_INVITES to { it.badgeInvites },
            AccountNotificationSwitch.BADGE_INBOX to { it.badgeInbox },
        )
        for ((switch, read) in reads) {
            val before = vm.state.value.choices ?: error("loaded")
            vm.onAction(NotificationSettingsAction.Set(switch, !read(before)))
            val changed = vm.state.value.choices ?: error("loaded")
            assertEquals(!read(before), read(changed), "$switch shows its change")
            runCurrent()
            assertEquals(read(before), read(vm.state.value.choices ?: error("loaded")), "$switch is taken back")
        }
        vm.close()
    }

    @Test fun `a refused switch is taken back and says why until dismissed`() = runTest(dispatcher) {
        val prefs = ScriptedPrefs(write = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) })
        val vm = viewModel(prefs)
        runCurrent()
        vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.REMINDERS, on = false))
        runCurrent()
        assertEquals(CHOICES, vm.state.value.choices)
        assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        vm.onAction(NotificationSettingsAction.DismissFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a switch that is already so and a switch before the load send nothing`() = runTest(dispatcher) {
        val prefs = ScriptedPrefs()
        val vm = viewModel(prefs)
        vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.APPROVALS, on = false))
        runCurrent()
        vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.APPROVALS, on = true))
        vm.onAction(NotificationSettingsAction.SetProblemsLevel(AccountProblemsLevel.CRITICAL))
        runCurrent()
        assertTrue(prefs.switches.isEmpty())
        assertTrue(prefs.levels.isEmpty())
        vm.close()
    }

    @Test fun `the problem level shows at once and is taken back when refused`() = runTest(dispatcher) {
        val ok =
            ScriptedPrefs(write = { RepositoryResult.Content(STORED.copy(problemsLevel = AccountProblemsLevel.ALL)) })
        val first = viewModel(ok)
        runCurrent()
        first.onAction(NotificationSettingsAction.SetProblemsLevel(AccountProblemsLevel.ALL))
        assertEquals(AccountProblemsLevel.ALL, first.state.value.choices?.problemsLevel)
        runCurrent()
        assertEquals(listOf(AccountProblemsLevel.ALL), ok.levels)
        assertEquals(AccountProblemsLevel.ALL, first.state.value.choices?.problemsLevel)
        first.close()

        val refused = ScriptedPrefs(write = { RepositoryResult.Failure(FailureKind.REJECTED) })
        val second = viewModel(refused)
        runCurrent()
        second.onAction(NotificationSettingsAction.SetProblemsLevel(AccountProblemsLevel.OFF))
        runCurrent()
        assertEquals(AccountProblemsLevel.CRITICAL, second.state.value.choices?.problemsLevel)
        assertEquals(Failed(FailureKind.REJECTED), second.state.value.writeFailure)
        second.close()
    }

    @Test fun `turning a notification on asks for the permission once per change and turning off never does`() =
        runTest(dispatcher) {
            val vm = viewModel(ScriptedPrefs())
            val effects = mutableListOf<NotificationSettingsEffect>()
            val collector = launch { vm.effects.collect { effects += it } }
            runCurrent()
            vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.BADGE_INBOX, on = true))
            runCurrent()
            assertEquals(listOf<NotificationSettingsEffect>(NotificationSettingsEffect.RequestPermission), effects)
            vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.INVITES, on = false))
            vm.onAction(NotificationSettingsAction.SetProblemsLevel(AccountProblemsLevel.ALL))
            runCurrent()
            assertEquals(1, effects.size, "turning off and raising a level that was on ask nothing")
            collector.cancel()
            vm.close()

            val quiet = STORED.copy(problemsLevel = AccountProblemsLevel.OFF)
            val fromOff = viewModel(
                ScriptedPrefs(
                    load = listOf({ RepositoryResult.Content(quiet) }),
                    write = { RepositoryResult.Content(quiet) },
                ),
            )
            val asked = mutableListOf<NotificationSettingsEffect>()
            val second = launch { fromOff.effects.collect { asked += it } }
            runCurrent()
            fromOff.onAction(NotificationSettingsAction.SetProblemsLevel(AccountProblemsLevel.CRITICAL))
            runCurrent()
            assertEquals(listOf<NotificationSettingsEffect>(NotificationSettingsEffect.RequestPermission), asked)
            second.cancel()
            fromOff.close()
        }

    @Test fun `a switch that is already on asks for nothing`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedPrefs())
        val effects = mutableListOf<NotificationSettingsEffect>()
        val collector = launch { vm.effects.collect { effects += it } }
        runCurrent()
        vm.onAction(NotificationSettingsAction.Set(AccountNotificationSwitch.APPROVALS, on = true))
        runCurrent()
        assertTrue(effects.isEmpty())
        collector.cancel()
        vm.close()
    }

    @Test fun `closing cancels the load and ignores later actions and clearing the store does the same`() =
        runTest(dispatcher) {
            val prefs = ScriptedPrefs(load = listOf(neverAnswers()))
            val vm = viewModel(prefs)
            runCurrent()
            vm.close()
            runCurrent()
            assertEquals(1, prefs.loads.cancellations)
            vm.onAction(NotificationSettingsAction.Retry)
            runCurrent()
            assertEquals(1, prefs.loads.calls)

            val stored = ScriptedPrefs(load = listOf(neverAnswers()))
            val store = ViewModelStore()
            val owned = store.provide {
                AccountViewModelFactory(
                    AccountUnusedAccount,
                    stored,
                    AccountUnusedUsage,
                    AccountUnusedTrash,
                    FakeAuthRepository(),
                ).notificationSettingsViewModel()
            }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(owned.isClosed)
            assertEquals(1, stored.loads.cancellations)
        }

    @Test fun `a load that was superseded and answers late is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val prefs = ScriptedPrefs(
            load = listOf(answersLate(gate, RepositoryResult.Content(STORED.copy(approvals = false))), {
                RepositoryResult.Content(STORED)
            }),
        )
        val vm = viewModel(prefs)
        runCurrent()
        vm.onAction(NotificationSettingsAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(true, vm.state.value.choices?.approvals)
        vm.close()
    }
}
