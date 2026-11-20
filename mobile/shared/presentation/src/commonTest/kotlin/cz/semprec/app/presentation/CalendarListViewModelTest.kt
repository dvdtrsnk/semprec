package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarCancellationImpact
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarListViewModelTest : MainDispatcherTest() {
    private val catalog = FakeCatalogRepository()
    private val sync = SyncChanges()
    private val accounts = ScriptedInternetAccountRepository(
        list = MailCall(
            mailContent(
                listOf(
                    internetAccount("m2", calendars = true, provider = "outlook"),
                    internetAccount("m1", calendars = true, calendarStatus = CalendarSyncStatus.OK),
                ),
            ),
        ),
    )

    private fun viewModel() =
        CalendarViewModelFactory(
            FakeCalendarRepository(catalog.changes),
            catalog,
            FakeInvitationRepository(),
            catalog.changes,
            accounts,
            sync = sync,
        ).calendarListViewModel()

    private fun TestScope.loaded(): CalendarListViewModel = viewModel().also { runCurrent() }

    private fun TestScope.act(vm: CalendarListViewModel, action: CalendarListAction) {
        vm.onAction(action)
        runCurrent()
    }

    @Test fun `starts loading and shows the calendars grouped by where they come from`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(CalendarListPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(CalendarListPhase.CONTENT, state.phase)
        assertEquals(
            listOf(CalendarGroup.OWN, CalendarGroup.OWN, CalendarGroup.SYSTEM, CalendarGroup.SUBSCRIPTION),
            state.calendars.map { it.group },
        )
        assertEquals(11, state.swatches.size)
        val personal = state.calendars.first { it.id == "personal" }
        assertTrue(personal.isDefault)
        assertTrue(personal.canRename)
        assertFalse(personal.canDelete)
        assertTrue(state.calendars.first { it.id == "work" }.canDelete)
        assertFalse(state.calendars.first { it.id == "tasks" }.canRename)
        assertEquals("tasks", state.calendars.first { it.id == "tasks" }.systemKey)
        vm.close()
    }

    @Test fun `account calendars are shown under their account with its provider and status`() = runTest(dispatcher) {
        catalog.calendars += listOf(
            accountCalendar("g1", "m1"),
            accountCalendar("o1", "m2", readOnly = true),
            accountCalendar("g2", "m1", color = "#FF3B30"),
            accountCalendar("x1", null),
            accountCalendar("z1", "m9"),
        )
        val state = loaded().also { it.close() }.state.value
        assertEquals(
            listOf(
                CalendarAccountSection("m2", "Gmail", "outlook", InternetServiceStatus.PENDING),
                CalendarAccountSection("m1", "Gmail", "gmail", InternetServiceStatus.OK),
                CalendarAccountSection("", null, null, null),
                CalendarAccountSection("m9", null, null, null),
            ),
            state.accounts,
        )
        val rows = state.calendars.associateBy { it.id }
        val accountIds = listOf("g1", "o1", "g2", "x1", "z1").map { rows[it]?.accountId }
        assertEquals(listOf("m1", "m2", "m1", "", "m9"), accountIds)
        val provider = rows.getValue("g1")
        assertEquals(CalendarGroup.ACCOUNT, provider.group)
        assertEquals("#0B8043" to true, provider.color to provider.usesRemoteColor)
        assertTrue(provider.canRename)
        assertFalse(provider.canDelete)
        assertFalse(provider.readOnly)
        assertTrue(rows.getValue("o1").readOnly)
        val recoloured = rows.getValue("g2")
        assertEquals("#FF3B30" to false, recoloured.color to recoloured.usesRemoteColor)
        assertEquals("#0B8043", recoloured.remoteColor)
        val others = state.calendars.filter { it.group != CalendarGroup.ACCOUNT }
        assertEquals(listOf(null), others.map { it.accountId }.distinct())
    }

    @Test fun `account calendars are shown when the accounts cannot be read`() = runTest(dispatcher) {
        catalog.calendars += accountCalendar("g1", "m1")
        val failing = ScriptedInternetAccountRepository(list = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = CalendarViewModelFactory(
            FakeCalendarRepository(),
            catalog,
            FakeInvitationRepository(),
            catalog.changes,
            failing,
        ).calendarListViewModel()
        runCurrent()
        assertEquals(CalendarListPhase.CONTENT, vm.state.value.phase)
        assertEquals(listOf(CalendarAccountSection("m1", null, null, null)), vm.state.value.accounts)
        assertEquals("m1", vm.state.value.calendars.single { it.id == "g1" }.accountId)
        vm.close()
    }

    @Test fun `the accounts are not read when no calendar belongs to one`() = runTest(dispatcher) {
        val vm = loaded()
        assertEquals(emptyList(), vm.state.value.accounts)
        assertEquals(0, accounts.list.count)
        vm.close()
    }

    @Test fun `an account calendar is renamed and recoloured here, not deleted`() = runTest(dispatcher) {
        catalog.calendars += accountCalendar("g1", "m1", color = "#FF3B30")
        val vm = loaded()
        act(vm, CalendarListAction.Change.Rename("g1", "Rodina"))
        act(vm, CalendarListAction.Change.SetColor("g1", "#FF9500"))
        act(vm, CalendarListAction.Change.UseRemoteColor("g1"))
        act(vm, CalendarListAction.RequestDelete("g1"))
        assertEquals(
            listOf(
                "edit g1 Rodina null null null",
                "edit g1 null #FF9500 null null",
                "edit g1 null null null null remoteColor",
            ),
            catalog.calls.filter { it.startsWith("edit") || it.startsWith("impact") },
        )
        assertFalse(vm.state.value.problem)
        vm.close()
    }

    @Test fun `only an account calendar goes back to the provider colour`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.Change.UseRemoteColor("work"))
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        assertTrue(catalog.calls.none { it.startsWith("edit") })
        vm.close()
    }

    @Test fun `pulling to refresh reads the list again and asks once a minute for the accounts to sync`() =
        runTest(dispatcher) {
            val vm = loaded()
            act(vm, CalendarListAction.Refresh)
            assertEquals(2, catalog.calls.count { it == "list" })
            assertEquals(listOf("m2", "m1"), accounts.syncs.asked)
            act(vm, CalendarListAction.Refresh)
            assertEquals(3, catalog.calls.count { it == "list" })
            assertEquals(listOf("m2", "m1"), accounts.syncs.asked)
            vm.close()
        }

    @Test fun `a failing load is an error that a retry recovers`() = runTest(dispatcher) {
        catalog.listResult = unavailable
        val vm = loaded()
        assertEquals(CalendarListPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        catalog.listResult = null
        act(vm, CalendarListAction.Retry)
        assertEquals(CalendarListPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `hiding a calendar writes it and reads the list again`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.Change.ToggleHidden("work"))
        assertTrue("edit work null null null true" in catalog.calls)
        assertEquals(2, catalog.calls.count { it == "list" })
        vm.close()
    }

    @Test fun `a hidden calendar is shown again`() = runTest(dispatcher) {
        catalog.calendars = catalog.calendars.map { if (it.id == "work") it.copy(hidden = true) else it }
        val vm = loaded()
        assertTrue(vm.state.value.calendars.first { it.id == "work" }.hidden)
        act(vm, CalendarListAction.Change.ToggleHidden("work"))
        assertTrue("edit work null null null false" in catalog.calls)
        vm.close()
    }

    @Test fun `hide all hides the shown calendars and show all shows the hidden ones`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.SetAllHidden(true))
        assertEquals(4, catalog.calls.count { it.startsWith("edit") && it.endsWith("true") })
        catalog.calls.clear()
        catalog.calendars = catalog.calendars.map { it.copy(hidden = it.id != "feed") }
        act(vm, CalendarListAction.Retry)
        act(vm, CalendarListAction.SetAllHidden(false))
        assertEquals(3, catalog.calls.count { it.startsWith("edit") && it.endsWith("false") })
        val before = catalog.calls.size
        catalog.calendars = catalog.calendars.map { it.copy(hidden = false) }
        act(vm, CalendarListAction.Retry)
        act(vm, CalendarListAction.SetAllHidden(false))
        assertTrue(catalog.calls.drop(before).none { it.startsWith("edit") })
        vm.close()
    }

    @Test fun `name colour and notification are written one field at a time`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.Change.Rename("work", " Job "))
        act(vm, CalendarListAction.Change.SetColor("work", "#FF9500"))
        act(vm, CalendarListAction.Change.SetNotify("work", false))
        assertTrue("edit work Job null null null" in catalog.calls)
        assertTrue("edit work null #FF9500 null null" in catalog.calls)
        assertTrue("edit work null null false null" in catalog.calls)
        vm.close()
    }

    @Test fun `a system calendar cannot be renamed but can be recoloured`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.Change.Rename("tasks", "Mine"))
        assertTrue(vm.state.value.problem)
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        act(vm, CalendarListAction.DismissProblem)
        act(vm, CalendarListAction.Change.SetColor("tasks", "#FF9500"))
        assertFalse(vm.state.value.problem)
        assertTrue("edit tasks null #FF9500 null null" in catalog.calls)
        vm.close()
    }

    @Test fun `a refused write is reported and the list stays`() = runTest(dispatcher) {
        val vm = loaded()
        catalog.writeResult = RepositoryResult.Failure(FailureKind.REJECTED)
        act(vm, CalendarListAction.Change.ToggleHidden("work"))
        assertTrue(vm.state.value.problem)
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        assertFalse(vm.state.value.busy)
        assertEquals(4, vm.state.value.calendars.size)
        vm.close()
    }

    @Test fun `an unknown calendar is ignored`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.Change.ToggleHidden("nope"))
        act(vm, CalendarListAction.Change.Rename("nope", "x"))
        act(vm, CalendarListAction.RequestDelete("nope"))
        assertTrue(catalog.calls.none { it.startsWith("edit") || it.startsWith("impact") })
        vm.close()
    }

    @Test fun `adding a calendar takes the first colour nobody has and opens its settings`() = runTest(dispatcher) {
        catalog.calendars = listOf(calendarInfo("personal", "#FF3B30", isDefault = true), calendarInfo("work"))
        val vm = loaded()
        act(vm, CalendarListAction.Add(" Trips "))
        assertTrue("create Trips #FF9500" in catalog.calls)
        assertEquals("new-cal", vm.state.value.detailId)
        vm.close()
    }

    @Test fun `a nameless calendar is not added`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.Add("  "))
        assertTrue(catalog.calls.none { it.startsWith("create") })
        assertTrue(vm.state.value.problem)
        vm.close()
    }

    @Test fun `the settings page opens and closes and follows a calendar that vanished`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.OpenDetail("work"))
        assertEquals("work", vm.state.value.detailId)
        catalog.calendars = catalog.calendars.filter { it.id != "work" }
        act(vm, CalendarListAction.Retry)
        assertNull(vm.state.value.detailId)
        act(vm, CalendarListAction.OpenDetail("personal"))
        act(vm, CalendarListAction.CloseDetail)
        assertNull(vm.state.value.detailId)
        vm.close()
    }

    @Test fun `deleting shows what it cancels and waits for the confirmation`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.RequestDelete("work"))
        assertEquals(CalendarImpact("work", 3, 2, 1), vm.state.value.impact)
        assertTrue(catalog.calls.none { it.startsWith("delete") })
        act(vm, CalendarListAction.ConfirmDelete)
        assertTrue("delete work" in catalog.calls)
        assertNull(vm.state.value.impact)
        vm.close()
    }

    @Test fun `a delete that is cancelled writes nothing`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, CalendarListAction.RequestDelete("work"))
        act(vm, CalendarListAction.CancelDelete)
        act(vm, CalendarListAction.ConfirmDelete)
        assertNull(vm.state.value.impact)
        assertTrue(catalog.calls.none { it.startsWith("delete") })
        vm.close()
    }

    @Test fun `the default system and subscribed calendars cannot be deleted`() = runTest(dispatcher) {
        val vm = loaded()
        listOf("personal", "tasks", "feed").forEach { act(vm, CalendarListAction.RequestDelete(it)) }
        assertTrue(catalog.calls.none { it.startsWith("impact") })
        vm.close()
    }

    @Test fun `a failing impact read is reported and a failing delete too`() = runTest(dispatcher) {
        val vm = loaded()
        catalog.impact = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        act(vm, CalendarListAction.RequestDelete("work"))
        assertNull(vm.state.value.impact)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.problemFailure)
        catalog.impact = RepositoryResult.Content(CalendarCancellationImpact(0, 0, 0))
        act(vm, CalendarListAction.RequestDelete("work"))
        catalog.writeResult = RepositoryResult.Failure(FailureKind.NOT_FOUND)
        act(vm, CalendarListAction.ConfirmDelete)
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.problemFailure)
        vm.close()
    }

    @Test fun `the sleep calendar's info opens the sleep settings`() = runTest(dispatcher) {
        val vm = loaded()
        val effects = mutableListOf<CalendarListEffect>()
        backgroundScope.launch { vm.effects.collect { effects += it } }
        act(vm, CalendarListAction.OpenSleep)
        assertEquals<List<CalendarListEffect>>(listOf(CalendarListEffect.OpenSleep), effects)
        vm.close()
    }

    @Test fun `a change another screen made reloads the list`() = runTest(dispatcher) {
        val vm = loaded()
        catalog.calendars = catalog.calendars.filter { it.id != "work" }
        catalog.changes.changed()
        runCurrent()
        assertEquals(3, vm.state.value.calendars.size)
        vm.close()
    }

    @Test fun `a calendar change the server reports reloads the list unless a write is under way`() =
        runTest(dispatcher) {
            val vm = loaded()
            catalog.calendars = catalog.calendars.filter { it.id != "work" }
            sync.raise(setOf(SyncTopic.INVITATIONS, SyncTopic.MAIL_ACCOUNTS))
            runCurrent()
            assertEquals(4, vm.state.value.calendars.size)
            sync.raise(setOf(SyncTopic.CALENDAR))
            runCurrent()
            assertEquals(3, vm.state.value.calendars.size)

            val gate = CompletableDeferred<Unit>()
            catalog.writeGate = gate
            act(vm, CalendarListAction.Change.ToggleHidden("personal"))
            sync.raise(setOf(SyncTopic.CALENDAR))
            runCurrent()
            assertEquals(2, catalog.calls.count { it == "list" })
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf("list", "list", "edit personal null null null true", "list"), catalog.calls.take(4))
            assertFalse(vm.state.value.busy)
            vm.close()
        }

    @Test fun `closing ignores actions and clearing the store closes it too`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(CalendarListAction.Change.ToggleHidden("work"))
        runCurrent()
        assertTrue(catalog.calls.none { it.startsWith("edit") })
        val other = loaded()
        other.close()
        other.onAction(CalendarListAction.Retry)
        assertEquals(2, catalog.calls.count { it == "list" })
    }

    @Test fun `a thrown exception while loading is an error without a reason`() = runTest(dispatcher) {
        val failing = object : cz.semprec.app.domain.CalendarCatalogRepository by catalog {
            override suspend fun calendars(): RepositoryResult<List<cz.semprec.app.domain.CalendarInfo>> = error("boom")
        }
        val vm = CalendarViewModelFactory(
            FakeCalendarRepository(),
            failing,
            FakeInvitationRepository(),
            catalog.changes,
            ScriptedInternetAccountRepository(),
        ).calendarListViewModel()
        runCurrent()
        assertEquals(CalendarListPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }
}
