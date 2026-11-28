package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CalendarAgendaPage
import cz.alldots.app.domain.CalendarAgendaRepository
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.ClockTime
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun agendaEntry(id: String, kind: CalendarEntryKind, day: CalendarDay, from: String? = null) = CalendarEntry(
    id = id,
    kind = kind,
    title = id.uppercase(),
    calendarId = "c",
    date = day,
    endDate = null,
    timeFrom = from?.let { ClockTime.parse(it) },
    timeTo = null,
    effectiveTo = null,
    allDay = from == null,
    status = if (id == "done") CalendarEntry.STATUS_DONE else null,
    place = null,
    readOnly = false,
    version = "1",
)

private val AGENDA_MONDAY = CalendarDay(2026, 11, 16)
private val AGENDA_TUESDAY = CalendarDay(2026, 11, 17)

/** Agenda pages a test answers by cursor; every read is recorded. */
private class ScriptedAgenda : CalendarAgendaRepository {
    val reads = mutableListOf<Pair<CalendarDay, String?>>()
    var onPage: suspend (String?) -> RepositoryResult<CalendarAgendaPage> = { cursor ->
        when (cursor) {
            null -> RepositoryResult.Content(
                CalendarAgendaPage(
                    listOf(
                        agendaEntry("done", CalendarEntryKind.TASK, AGENDA_MONDAY),
                        agendaEntry("e1", CalendarEntryKind.EVENT, AGENDA_MONDAY, "14:00"),
                        agendaEntry("b1", CalendarEntryKind.BIRTHDAY, AGENDA_MONDAY),
                    ),
                    "next",
                ),
            )
            else -> RepositoryResult.Content(
                CalendarAgendaPage(listOf(agendaEntry("e2", CalendarEntryKind.EVENT, AGENDA_TUESDAY, "09:00")), null),
            )
        }
    }

    override suspend fun page(from: CalendarDay, cursor: String?): RepositoryResult<CalendarAgendaPage> {
        reads += from to cursor
        return onPage(cursor)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarAgendaViewModelTest : MainDispatcherTest() {
    private val agenda = ScriptedAgenda()

    private fun viewModel(from: String = "2026-11-16") = CalendarAgendaViewModel(from, agenda)

    @Test fun `the first page shows its events and tasks by day`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(CalendarAgendaPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(CalendarAgendaPhase.CONTENT, state.phase)
        assertEquals(listOf<Pair<CalendarDay, String?>>(AGENDA_MONDAY to null), agenda.reads)
        val monday = state.days.single()
        assertEquals("2026-11-16", monday.day)
        assertEquals(listOf("done", "e1"), monday.entries.map { it.id }, "Derived entries are not in the agenda")
        assertTrue(monday.entries[0].done)
        assertTrue(monday.entries[0].allDay)
        assertEquals("14:00", monday.entries[1].timeFrom)
        assertEquals(CalendarAgendaKind.EVENT, monday.entries[1].kind)
        assertTrue(state.hasMore)
        vm.close()
    }

    @Test fun `a day lists what has no time first and the rest by time whatever it is`() = runTest(dispatcher) {
        agenda.onPage = {
            RepositoryResult.Content(
                CalendarAgendaPage(
                    listOf(
                        agendaEntry("late", CalendarEntryKind.EVENT, AGENDA_MONDAY, "18:00"),
                        agendaEntry("reminder", CalendarEntryKind.TASK, AGENDA_MONDAY, "14:45"),
                        agendaEntry("early", CalendarEntryKind.EVENT, AGENDA_MONDAY, "08:00"),
                        agendaEntry("open", CalendarEntryKind.TASK, AGENDA_MONDAY),
                    ),
                    null,
                ),
            )
        }
        val vm = viewModel()
        runCurrent()
        assertEquals(listOf("open", "early", "reminder", "late"), vm.state.value.days.single().entries.map { it.id })
        vm.close()
    }

    @Test fun `a further page joins the days and the last page ends the agenda`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.onAction(CalendarAgendaAction.LoadMore)
        assertTrue(vm.state.value.loadingMore)
        runCurrent()
        val state = vm.state.value
        assertEquals(listOf("2026-11-16", "2026-11-17"), state.days.map { it.day })
        assertFalse(state.hasMore)
        assertFalse(state.loadingMore)
        vm.onAction(CalendarAgendaAction.LoadMore)
        runCurrent()
        assertEquals(listOf(null, "next"), agenda.reads.map { it.second }, "Nothing is read after the last page")
        vm.close()
    }

    @Test fun `a refused further page keeps the days and says why`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        agenda.onPage = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        vm.onAction(CalendarAgendaAction.LoadMore)
        runCurrent()
        val state = vm.state.value
        assertEquals(Failed(FailureKind.UNAVAILABLE), state.moreFailure)
        assertEquals(1, state.days.size)
        assertTrue(state.hasMore)
        vm.close()
    }

    @Test fun `a second further page waits for the first`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        val gate = CompletableDeferred<RepositoryResult<CalendarAgendaPage>>()
        agenda.onPage = { gate.await() }
        vm.onAction(CalendarAgendaAction.LoadMore)
        vm.onAction(CalendarAgendaAction.LoadMore)
        runCurrent()
        assertEquals(2, agenda.reads.size)
        gate.complete(RepositoryResult.Content(CalendarAgendaPage(emptyList(), null)))
        runCurrent()
        assertFalse(vm.state.value.hasMore)
        vm.close()
    }

    @Test fun `a failed first page is an error and retry reads again`() = runTest(dispatcher) {
        agenda.onPage = { RepositoryResult.Failure(FailureKind.UNAUTHORIZED) }
        val vm = viewModel()
        runCurrent()
        assertEquals(CalendarAgendaPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
        vm.onAction(CalendarAgendaAction.LoadMore)
        runCurrent()
        assertEquals(1, agenda.reads.size, "An agenda that failed has no further page")
        agenda.onPage = { RepositoryResult.Content(CalendarAgendaPage(emptyList(), null)) }
        vm.onAction(CalendarAgendaAction.Retry)
        runCurrent()
        assertEquals(CalendarAgendaPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        agenda.onPage = { error("boom") }
        val vm = viewModel()
        runCurrent()
        assertEquals(CalendarAgendaPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a first day that is no day is invalid data and nothing is read`() = runTest(dispatcher) {
        val vm = viewModel("someday")
        runCurrent()
        assertEquals(CalendarAgendaPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.INVALID_DATA, vm.state.value.failure)
        assertTrue(agenda.reads.isEmpty())
        vm.close()
    }

    @Test fun `opening an entry raises its details once and an unknown entry nothing`() = runTest(dispatcher) {
        val vm = viewModel()
        val seen = mutableListOf<CalendarAgendaEffect>()
        backgroundScope.launch { vm.effects.collect { seen += it } }
        runCurrent()
        vm.onAction(CalendarAgendaAction.Open("e1"))
        vm.onAction(CalendarAgendaAction.Open("done"))
        vm.onAction(CalendarAgendaAction.Open("missing"))
        runCurrent()
        assertEquals<List<CalendarAgendaEffect>>(
            listOf(
                CalendarAgendaEffect.OpenDetails(CalendarAgendaKind.EVENT, "e1"),
                CalendarAgendaEffect.OpenDetails(CalendarAgendaKind.TASK, "done"),
            ),
            seen,
        )
        vm.close()
    }

    @Test fun `a retry supersedes a slow page and closing ignores every action`() = runTest(dispatcher) {
        val slow = CompletableDeferred<RepositoryResult<CalendarAgendaPage>>()
        agenda.onPage = { slow.await() }
        val vm = viewModel()
        runCurrent()
        agenda.onPage = { RepositoryResult.Content(CalendarAgendaPage(emptyList(), null)) }
        vm.onAction(CalendarAgendaAction.Retry)
        runCurrent()
        slow.complete(RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        runCurrent()
        assertEquals(CalendarAgendaPhase.CONTENT, vm.state.value.phase, "The superseded page is not shown")
        vm.close()
        vm.onAction(CalendarAgendaAction.Retry)
        runCurrent()
        assertEquals(2, agenda.reads.size)
    }

    @Test fun `a write elsewhere in the window reads the agenda again from its first day`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val vm = CalendarAgendaViewModel("2026-11-16", agenda, changes)
        runCurrent()
        agenda.onPage = {
            RepositoryResult.Content(
                CalendarAgendaPage(listOf(agendaEntry("new", CalendarEntryKind.EVENT, AGENDA_MONDAY, "08:00")), null),
            )
        }
        changes.emit(Unit)
        runCurrent()
        assertEquals(listOf<Pair<CalendarDay, String?>>(AGENDA_MONDAY to null, AGENDA_MONDAY to null), agenda.reads)
        assertEquals(listOf("new"), vm.state.value.days.single().entries.map { it.id })
        vm.close()
    }
}
