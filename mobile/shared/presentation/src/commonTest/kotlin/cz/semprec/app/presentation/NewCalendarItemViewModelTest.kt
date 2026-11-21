package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class NewCalendarItemViewModelTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository()
    private val catalog = FakeCatalogRepository()

    private fun viewModel(source: CalendarCatalogRepository = catalog) =
        CalendarViewModelFactory(
            repository,
            source,
            FakeInvitationRepository(),
            repository.changes,
            ScriptedInternetAccountRepository(),
        ).newCalendarItemViewModel("2026-10-17")

    private fun TestScope.loaded(): NewCalendarItemViewModel = viewModel().also { runCurrent() }

    private fun TestScope.effectsOf(vm: NewCalendarItemViewModel): List<NewItemEffect> {
        val received = mutableListOf<NewItemEffect>()
        backgroundScope.launch { vm.effects.collect { received += it } }
        return received
    }

    private fun event(
        title: String = "Lunch",
        timed: Boolean = true,
        start: Int = 12 * 60 + 5,
        hasEnd: Boolean = true,
        end: Int = 13 * 60,
        place: String = "Cafe",
        calendarId: String = "work",
    ) = NewItemAction.Create(NewItemKind.EVENT, title, "2026-10-17", timed, start, hasEnd, end, place, calendarId)

    @Test fun `starts loading and offers the own calendars`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(NewItemPhase.LOADING, vm.state.value.phase)
        assertEquals("2026-10-17", vm.state.value.defaultDay)
        runCurrent()
        assertEquals(NewItemPhase.EDITING, vm.state.value.phase)
        assertEquals(listOf("personal", "work"), vm.state.value.calendars.map { it.id })
        assertTrue(vm.state.value.calendars.first().isDefault)
        vm.close()
    }

    @Test fun `offers the writable account calendars but not the read-only ones`() = runTest(dispatcher) {
        catalog.calendars += listOf(accountCalendar("g1", "m1"), accountCalendar("g2", "m1", readOnly = true))
        val vm = viewModel()
        runCurrent()
        assertEquals(listOf("personal", "work", "g1"), vm.state.value.calendars.map { it.id })
        assertEquals("#0B8043", vm.state.value.calendars.last().color)
        vm.close()
    }

    @Test fun `the own calendars come first then each account's in the order they are listed`() = runTest(dispatcher) {
        catalog.calendars += listOf(
            synced("g1", "m1", "Family", "iCloud", "david@tresnak.cc"),
            synced("o1", "m2", "Team", "Outlook", "david@work.cz"),
            synced("g2", "m1", "Timelog", "iCloud", "david@tresnak.cc"),
            synced("x1", null, "Shared", null, null),
        )
        val state = loaded().also { it.close() }.state.value
        val icloud = NewItemAccount("m1", "iCloud", "david@tresnak.cc")
        assertEquals(
            listOf(null, icloud, NewItemAccount("m2", "Outlook", "david@work.cz"), NewItemAccount("", null, null)),
            state.groups.map { it.account },
        )
        assertEquals(
            listOf(listOf("personal", "work"), listOf("g1", "g2"), listOf("o1"), listOf("x1")),
            state.groups.map { group -> group.calendars.map { it.id } },
        )
        assertEquals(listOf(icloud, icloud), state.groups[1].calendars.map { it.account })
        assertEquals(listOf("personal", "work", "g1", "g2", "o1", "x1"), state.calendars.map { it.id })
    }

    @Test fun `read-only system and subscribed calendars are not offered and leave no empty group`() =
        runTest(dispatcher) {
            catalog.calendars += listOf(
                synced("g1", "m1", "Holidays", "iCloud", "a@icloud.com", readOnly = true),
                synced("o1", "m2", "Team", "Outlook", "b@work.cz"),
            )
            val state = loaded().also { it.close() }.state.value
            assertEquals(listOf(null, "m2"), state.groups.map { it.account?.id })
            assertEquals(listOf("personal", "work", "o1"), state.calendars.map { it.id })
        }

    @Test fun `a name another offered calendar has too is shown with its source`() = runTest(dispatcher) {
        catalog.calendars = listOf(
            own("own-personal", "Osobní"),
            own("own-family", "Rodina"),
            own("own-work", "Práce"),
            synced("g1", "m1", " osobní ", "iCloud", "david@tresnak.cc"),
            synced("g2", "m1", "Rodina", "iCloud", "david@tresnak.cc"),
            synced("g3", "m1", "Work", "iCloud", "david@tresnak.cc"),
            synced("g4", "m2", "Rodina", "Family", "family@icloud.com"),
            synced("g5", "m3", "Rodina", "Family", "anna@icloud.com"),
            synced("g6", "m4", "Rodina", null, "shared@example.com"),
            synced("g7", "m5", "Rodina", null, null),
        )
        val qualifiers = loaded().also { it.close() }.state.value.calendars.associate { it.id to it.qualifier }
        assertEquals(
            mapOf(
                "own-personal" to NewItemCalendarQualifier.OWN,
                "own-family" to NewItemCalendarQualifier.OWN,
                "own-work" to NewItemCalendarQualifier.NONE,
                "g1" to NewItemCalendarQualifier.ACCOUNT_NAME,
                "g2" to NewItemCalendarQualifier.ACCOUNT_NAME,
                "g3" to NewItemCalendarQualifier.NONE,
                "g4" to NewItemCalendarQualifier.ACCOUNT_ADDRESS,
                "g5" to NewItemCalendarQualifier.ACCOUNT_ADDRESS,
                "g6" to NewItemCalendarQualifier.ACCOUNT_ADDRESS,
                "g7" to NewItemCalendarQualifier.ACCOUNT_NAME,
            ),
            qualifiers,
        )
    }

    @Test fun `the form works when the calendars cannot be read`() = runTest(dispatcher) {
        catalog.listResult = unavailable
        val vm = loaded()
        assertEquals(NewItemPhase.EDITING, vm.state.value.phase)
        assertTrue(vm.state.value.calendars.isEmpty())
        vm.close()
    }

    @Test fun `an event is created with snapped times a place and its calendar`() = runTest(dispatcher) {
        val vm = loaded()
        val effects = effectsOf(vm)
        vm.onAction(event())
        assertEquals(NewItemPhase.SAVING, vm.state.value.phase)
        runCurrent()
        assertEquals(listOf(NewItemEffect.Created("new1")), effects)
        assertEquals("create EVENT Lunch 2026-10-17 12:00 13:00 Cafe work", repository.calls.last())
        vm.close()
    }

    @Test fun `an all day event and a task without a time carry no times`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(event(title = "Trip", timed = false, place = " ", calendarId = ""))
        runCurrent()
        assertEquals("create EVENT Trip 2026-10-17 null null null null", repository.calls.last())
        val task = NewItemAction.Create(NewItemKind.TASK, "Pay", "2026-10-17", false, 0, false, 0, "", "")
        val other = loaded()
        other.onAction(task)
        runCurrent()
        assertEquals("create TASK Pay 2026-10-17 null null null null", repository.calls.last())
        vm.close()
        other.close()
    }

    @Test fun `a task at a time has no end unless it gets one`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(NewItemAction.Create(NewItemKind.TASK, "Call", "2026-10-17", true, 14 * 60, false, 0, "", ""))
        runCurrent()
        assertEquals("create TASK Call 2026-10-17 14:00 null null null", repository.calls.last())
        vm.close()
    }

    @Test fun `a form that cannot work fails without asking the server`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(event(title = "  "))
        assertEquals(NewItemPhase.SAVING, vm.state.value.phase)
        runCurrent()
        assertEquals(NewItemPhase.FAILED, vm.state.value.phase)
        assertEquals(FailureKind.REJECTED, vm.state.value.failure)
        vm.onAction(event(start = 13 * 60, end = 12 * 60))
        assertEquals(NewItemPhase.FAILED, vm.state.value.phase)
        vm.onAction(NewItemAction.Create(NewItemKind.EVENT, "Lunch", "never", false, 0, false, 0, "", ""))
        assertEquals(FailureKind.REJECTED, vm.state.value.failure)
        assertTrue(repository.calls.none { it.startsWith("create") })
        vm.close()
    }

    @Test fun `an edit takes the failure away and a server failure is shown`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(event(title = ""))
        runCurrent()
        vm.onAction(NewItemAction.Edited)
        assertEquals(NewItemPhase.EDITING, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        repository.writeResult = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        vm.onAction(event())
        runCurrent()
        assertEquals(NewItemPhase.FAILED, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        vm.close()
    }

    @Test fun `a second create is ignored while the first is saved`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(event())
        vm.onAction(event(title = "Other"))
        runCurrent()
        assertEquals(1, repository.calls.count { it.startsWith("create") })
        vm.close()
    }

    @Test fun `a thrown exception while reading the calendars leaves the form usable`() = runTest(dispatcher) {
        val failing = object : CalendarCatalogRepository by catalog {
            override suspend fun calendars(): RepositoryResult<List<CalendarInfo>> = error("boom")
        }
        val vm = viewModel(failing)
        runCurrent()
        assertEquals(NewItemPhase.EDITING, vm.state.value.phase)
        assertTrue(vm.state.value.calendars.isEmpty())
        vm.close()
    }

    @Test fun `closing ignores actions and clearing the store closes it too`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(event())
        runCurrent()
        assertTrue(repository.calls.none { it.startsWith("create") })
    }

    private fun own(id: String, name: String) = calendarInfo(id).copy(name = name)

    private fun synced(
        id: String,
        accountId: String?,
        name: String,
        accountName: String?,
        address: String?,
        readOnly: Boolean = false,
    ) = accountCalendar(id, accountId, readOnly).copy(name = name, accountName = accountName, accountAddress = address)
}
