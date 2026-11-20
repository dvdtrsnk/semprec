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
}
