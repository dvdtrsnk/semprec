package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.EventTaskEntry
import cz.semprec.app.domain.EventTaskState
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNightChange
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val MEETING = entry("meeting", schedule = schedule("10:00", "11:30"))
private val INVOICE = entry("invoice", CalendarEntryKind.TASK, schedule("14:00", null), calendarId = "tasks")

/** Ticking a task off inside an event, and moving and stretching a night of sleep on the timeline. */
@OptIn(ExperimentalCoroutinesApi::class)
class CalendarEventTaskAndNightTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository()
    private val sleep = FakeSleepRepository(sleepContent())

    private fun serve(vararg entries: cz.semprec.app.domain.CalendarEntry) {
        repository.onWindow = { _, _ -> RepositoryResult.Content(window(entries.toList())) }
    }

    private fun TestScope.loaded(): CalendarViewModel =
        CalendarViewModelFactory(
            repository,
            FakeCatalogRepository(),
            FakeInvitationRepository(),
            repository.changes,
            ScriptedInternetAccountRepository(),
            sleep = sleep,
        ).calendarViewModel("2026-10-16").also { runCurrent() }

    private fun CalendarViewModel.item(id: String): CalendarItem =
        state.value.days.flatMap { it.items }.first { it.id == id }

    private fun CalendarViewModel.day(date: String): CalendarDayState = state.value.days.first { it.date == date }

    private fun TestScope.effectsOf(vm: CalendarViewModel): List<CalendarEffect> {
        val received = mutableListOf<CalendarEffect>()
        backgroundScope.launch { vm.effects.collect { received += it } }
        return received
    }

    private fun TestScope.act(vm: CalendarViewModel, action: CalendarAction) {
        vm.onAction(action)
        runCurrent()
    }

    @Test fun `a task ticked off inside an event is done there whatever it was there before`() = runTest(dispatcher) {
        val missed = EventTaskEntry("missed", "Missed", EventTaskState.MISSED, null)
        val elsewhere = EventTaskEntry("elsewhere", "Elsewhere", EventTaskState.DONE_ELSEWHERE, "2026-10-16")
        val open = EventTaskEntry("open", "Open", EventTaskState.OPEN, null)
        serve(MEETING.copy(tasks = listOf(missed, elsewhere, open)))
        val vm = loaded()
        for (id in listOf("missed", "elsewhere", "open")) {
            act(vm, CalendarAction.Gesture.ToggleDone(id, inEventId = "meeting"))
        }
        assertEquals(
            listOf("complete missed in meeting", "complete elsewhere in meeting", "complete open in meeting"),
            repository.calls.filter { it.startsWith("complete") },
        )
        assertTrue(repository.calls.none { it.startsWith("done") })
        vm.close()
    }

    @Test fun `a task done inside an event opens again from its checkbox there`() = runTest(dispatcher) {
        val done = EventTaskEntry("done", "Done", EventTaskState.DONE, null)
        serve(MEETING.copy(tasks = listOf(done)))
        val vm = loaded()
        act(vm, CalendarAction.Gesture.ToggleDone("done", inEventId = "meeting"))
        assertEquals(
            listOf("done done false"),
            repository.calls.filter { it.startsWith("done") || it.startsWith("complete") },
        )
        vm.close()
    }

    @Test fun `a checkbox in an event that is no longer shown writes nothing`() = runTest(dispatcher) {
        serve(INVOICE)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.ToggleDone("invoice", inEventId = "gone"))
        assertTrue(repository.calls.none { it.startsWith("done") || it.startsWith("complete") })
        vm.close()
    }

    @Test fun `a night is moved and stretched as a preview and written for itself alone`() = runTest(dispatcher) {
        serve(sleepEntry(DAY_ZERO))
        val vm = loaded()
        act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", edge = null, deltaMinutes = -58))
        assertEquals(
            CalendarSleepDrag("2026-10-16", 22 * 60, 5 * 60 + 45, committing = false),
            vm.state.value.sleepDrag,
        )
        act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", CalendarEdge.START, deltaMinutes = -38))
        assertEquals(22 * 60 + 15, vm.state.value.sleepDrag?.bedMinutes)
        assertEquals(6 * 60 + 45, vm.state.value.sleepDrag?.wakeMinutes)
        act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", CalendarEdge.END, deltaMinutes = 44))
        assertEquals(23 * 60 to 7 * 60 + 30, vm.state.value.sleepDrag?.let { it.bedMinutes to it.wakeMinutes })
        act(vm, CalendarAction.Gesture.EndSleepDrag(commit = true))
        assertEquals(
            listOf("night:2026-10-16:${SleepNightChange(bed = ClockTime(23 * 60), wake = ClockTime(7 * 60 + 30))}"),
            sleep.writes,
        )
        assertEquals(null, vm.state.value.sleepDrag)
        vm.close()
    }

    @Test fun `a night is never shorter than an hour and a drag let go where it began writes nothing`() =
        runTest(dispatcher) {
            serve(sleepEntry(DAY_ZERO))
            val vm = loaded()
            act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", CalendarEdge.END, deltaMinutes = -7 * 60))
            assertEquals(null, vm.state.value.sleepDrag)
            act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", edge = null, deltaMinutes = 3))
            act(vm, CalendarAction.Gesture.EndSleepDrag(commit = true))
            assertEquals(emptyList(), sleep.writes)
            assertEquals(null, vm.state.value.sleepDrag)
            vm.close()
        }

    @Test fun `a night whose write failed can be moved again`() = runTest(dispatcher) {
        sleep.writeAnswer = unavailable
        serve(sleepEntry(DAY_ZERO))
        val vm = loaded()
        act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", edge = null, deltaMinutes = 30))
        act(vm, CalendarAction.Gesture.EndSleepDrag(commit = true))
        assertEquals(1, sleep.writes.size)
        assertEquals(null, vm.state.value.sleepDrag)
        assertTrue(vm.state.value.problem)
        act(vm, CalendarAction.Gesture.SleepDrag("2026-10-16", edge = null, deltaMinutes = 60))
        assertEquals(false, vm.state.value.sleepDrag?.committing)
        vm.close()
    }

    @Test fun `a task listed inside an event can be opened and ticked off`() = runTest(dispatcher) {
        val agenda = EventTaskEntry("agenda", "Agenda", EventTaskState.OPEN, null)
        val review = EventTaskEntry("review", "Review", EventTaskState.DONE, null)
        serve(MEETING.copy(tasks = listOf(agenda, review)))
        val vm = loaded()
        val effects = effectsOf(vm)
        act(vm, CalendarAction.Gesture.Tap("agenda"))
        assertEquals(CalendarEffect.OpenDetails("agenda", CalendarItemKind.TASK, "2026-10-16"), effects.single())
        act(vm, CalendarAction.Gesture.ToggleDone("agenda"))
        act(vm, CalendarAction.Gesture.ToggleDone("review"))
        assertEquals(listOf("done agenda true", "done review false"), repository.calls.filter { it.startsWith("done") })
        val states = vm.item("meeting").tasks.map { it.state }
        assertEquals(listOf(CalendarTaskInEvent.OPEN, CalendarTaskInEvent.DONE), states)
        vm.close()
    }

    @Test fun `a listed task is not a separate item of the day and does not shadow a task of the window`() =
        runTest(dispatcher) {
            val same = EventTaskEntry("invoice", "Invoice", EventTaskState.OPEN, null)
            serve(MEETING.copy(tasks = listOf(same)), INVOICE)
            val vm = loaded()
            assertEquals(listOf("meeting", "invoice"), vm.day("2026-10-16").items.map { it.id })
            act(vm, CalendarAction.Gesture.ToggleDone("invoice"))
            assertEquals(listOf("done invoice true"), repository.calls.filter { it.startsWith("done") })
            vm.close()
        }
}
