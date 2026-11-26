package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.EventTaskEntry
import cz.semprec.app.domain.EventTaskState
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val MEETING = entry("meeting", schedule = schedule("10:00", "11:30"))
private val LUNCH = entry("lunch", schedule = schedule("10:30", "12:00"))
private val INVOICE = entry("invoice", CalendarEntryKind.TASK, schedule("14:00", null), calendarId = "tasks")
private val STANDUP =
    entry("series@2026-10-16", schedule = schedule("09:00", "09:30"), readOnly = true, seriesId = "series")
private val HOLIDAY = entry("holiday", CalendarEntryKind.HOLIDAY, schedule(null, null), readOnly = true)
private val TRIP = entry("trip", schedule = schedule(null, null, endDay = DAY_ZERO.plusDays(2)))

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarViewModelTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository()

    private fun viewModel(day: String = "2026-10-16") =
        CalendarViewModelFactory(
            repository,
            FakeCatalogRepository(),
            FakeInvitationRepository(),
            repository.changes,
            ScriptedInternetAccountRepository(),
        ).calendarViewModel(day)

    private fun serve(vararg entries: cz.semprec.app.domain.CalendarEntry, pending: Int = 0) {
        repository.onWindow = { _, _ ->
            RepositoryResult.Content(
                window(entries.toList(), listOf(calendarInfo("work"), calendarInfo("tasks", "#FF9500")), pending),
            )
        }
    }

    private fun TestScope.loaded(day: String = "2026-10-16"): CalendarViewModel =
        viewModel(day).also { runCurrent() }

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

    @Test fun `starts loading on the given day in the day view`() = runTest(dispatcher) {
        val vm = viewModel("2026-10-14")
        val state = vm.state.value
        assertEquals(CalendarPhase.LOADING, state.phase)
        assertEquals(CalendarZoom.DAY, state.zoom)
        assertEquals("2026-10-14", state.selectedDay)
        assertEquals(42, state.monthGrid.size)
        assertEquals("2026-09-28", state.monthGrid.first())
        assertEquals("2026-11-08", state.monthGrid.last())
        vm.close()
    }

    @Test fun `a bad initial day falls back and the server names today`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded("nonsense")
        assertEquals("2026-10-16", vm.state.value.today)
        assertEquals(13 * 60 + 24, vm.state.value.nowMinutes)
        vm.close()
    }

    @Test fun `the window covers the month grid and a week on each side`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        val gridStart = DAY_ZERO.startOfMonth().startOfWeek()
        assertEquals(gridStart.plusDays(-7) to gridStart.plusDays(49), repository.ranges.single())
        assertEquals(57, vm.state.value.days.size)
        assertEquals("2026-09-21", vm.state.value.days.first().date)
        assertEquals("2026-11-16", vm.state.value.days.last().date)
        vm.close()
    }

    @Test fun `items are laid out beside the ones they overlap and coloured by their calendar`() = runTest(dispatcher) {
        serve(MEETING, LUNCH, INVOICE)
        val vm = loaded()
        val meeting = vm.item("meeting")
        val lunch = vm.item("lunch")
        assertEquals(CalendarPhase.CONTENT, vm.state.value.phase)
        assertEquals(0 to 2, meeting.column to meeting.columns)
        assertEquals(1 to 2, lunch.column to lunch.columns)
        assertEquals("#007AFF", meeting.color)
        assertEquals("#FF9500", vm.item("invoice").color)
        assertEquals(600, meeting.startMinutes)
        assertEquals(690, meeting.endMinutes)
        assertTrue(meeting.hasEnd)
        val invoice = vm.item("invoice")
        assertEquals(14 * 60, invoice.startMinutes)
        assertEquals(14 * 60 + 30, invoice.endMinutes)
        assertFalse(invoice.hasEnd)
        vm.close()
    }

    @Test fun `all day items and a holiday have no times and a span shows on each of its days`() = runTest(dispatcher) {
        serve(HOLIDAY, TRIP)
        val vm = loaded()
        assertTrue(vm.item("holiday").allDay)
        assertNull(vm.item("holiday").startMinutes)
        assertFalse(vm.item("holiday").editable)
        listOf("2026-10-16", "2026-10-17", "2026-10-18").forEach { date ->
            assertTrue(vm.day(date).items.any { it.id == "trip" && it.allDay })
        }
        assertTrue(vm.day("2026-10-19").items.none { it.id == "trip" })
        vm.close()
    }

    @Test fun `a sleep night draws an evening band and a morning band on the next day`() = runTest(dispatcher) {
        serve(sleepEntry(DAY_ZERO))
        val vm = loaded()
        assertEquals(23 * 60, vm.day("2026-10-16").sleepEvening?.bedMinutes)
        assertEquals(22 * 60 + 30, vm.day("2026-10-16").sleepEvening?.prepMinutes)
        assertEquals(6 * 60 + 45, vm.day("2026-10-17").sleepMorning?.wakeMinutes)
        assertEquals(23 * 60 to 24 * 60, vm.day("2026-10-16").sleepEvening?.let { it.fromMinutes to it.toMinutes })
        assertEquals(0 to 6 * 60 + 45, vm.day("2026-10-17").sleepMorning?.let { it.fromMinutes to it.toMinutes })
        assertNull(vm.day("2026-10-17").sleepMorning?.prepMinutes)
        assertNull(vm.day("2026-10-16").sleepMorning)
        assertTrue(vm.day("2026-10-16").items.isEmpty())
        vm.close()
    }

    @Test fun `the invitation count and the months of the year are in the state`() = runTest(dispatcher) {
        serve(MEETING, pending = 3)
        val vm = loaded()
        assertEquals(3, vm.state.value.pendingInvitations)
        val october = vm.state.value.months[9]
        assertEquals(CalendarMonthState(2026, 10, 3, 31), october)
        assertEquals(12, vm.state.value.months.size)
        vm.close()
    }

    @Test fun `a failing first load is an error that a retry recovers`() = runTest(dispatcher) {
        repository.onWindow = { _, _ -> unavailable }
        val vm = loaded()
        assertEquals(CalendarPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        serve(MEETING)
        act(vm, CalendarAction.Navigation.Retry)
        assertEquals(CalendarPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a reason`() = runTest(dispatcher) {
        repository.onWindow = { _, _ -> error("boom") }
        val vm = loaded()
        assertEquals(CalendarPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a failing reload keeps the content and reports a problem`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        repository.onWindow = { _, _ -> unavailable }
        act(vm, CalendarAction.Navigation.Refresh)
        assertEquals(CalendarPhase.CONTENT, vm.state.value.phase)
        assertEquals(1, vm.state.value.days.flatMap { it.items }.size)
        assertTrue(vm.state.value.problem)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.problemFailure)
        act(vm, CalendarAction.Edit.DismissProblem)
        assertFalse(vm.state.value.problem)
        vm.close()
    }

    @Test fun `a load that answers late after a newer one does not publish`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        var calls = 0
        repository.onWindow = { _, _ ->
            calls += 1
            val mine = calls
            // The first load ignores its cancellation and answers last, as a data layer may.
            if (mine == 1) withContext(NonCancellable) { gate.await() }
            RepositoryResult.Content(window(listOf(if (mine == 1) MEETING else LUNCH)))
        }
        val vm = viewModel()
        runCurrent()
        act(vm, CalendarAction.Navigation.Refresh)
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("lunch"), vm.state.value.days.flatMap { it.items }.map { it.id })
        vm.close()
    }

    @Test fun `closing during a load publishes nothing and ignores later actions`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.close()
        runCurrent()
        assertEquals(CalendarPhase.LOADING, vm.state.value.phase)
        vm.onAction(CalendarAction.Navigation.Show(CalendarZoom.MONTH, "2026-11-02"))
        assertEquals(CalendarZoom.DAY, vm.state.value.zoom)
        assertEquals(0, repository.calls.count { it == "window" })
    }

    @Test fun `clearing the store without close ends the ViewModel too`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(CalendarAction.Navigation.Refresh)
        runCurrent()
        assertEquals(1, repository.calls.count { it == "window" })
    }

    @Test fun `paging a day stays inside the window and loads nothing`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Navigation.Page(1))
        act(vm, CalendarAction.Navigation.Page(1))
        assertEquals("2026-10-18", vm.state.value.selectedDay)
        assertEquals(1, repository.calls.count { it == "window" })
        act(vm, CalendarAction.Navigation.Page(-3))
        assertEquals("2026-10-15", vm.state.value.selectedDay)
        vm.close()
    }

    @Test fun `a day in another month loads that month and keeps the content meanwhile`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded("2026-10-30")
        act(vm, CalendarAction.Navigation.Page(2))
        assertEquals("2026-11-01", vm.state.value.selectedDay)
        assertEquals(2, repository.calls.count { it == "window" })
        assertEquals(CalendarPhase.CONTENT, vm.state.value.phase)
        assertEquals("2026-10-26", vm.state.value.monthGrid.first())
        vm.close()
    }

    @Test fun `zooming changes the shown zoom and the month grid follows the selected day`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Navigation.Show(CalendarZoom.MONTH, "2026-10-20"))
        assertEquals(CalendarZoom.MONTH, vm.state.value.zoom)
        assertEquals("2026-10-20", vm.state.value.selectedDay)
        act(vm, CalendarAction.Navigation.Page(1))
        assertEquals("2026-11-20", vm.state.value.selectedDay)
        act(vm, CalendarAction.Navigation.Show(CalendarZoom.YEAR, "2026-11-20"))
        act(vm, CalendarAction.Navigation.Page(-1))
        assertEquals("2025-11-20", vm.state.value.selectedDay)
        assertEquals(2025, vm.state.value.months.first().year)
        vm.close()
    }

    @Test fun `an unreadable day is ignored and today brings the view back`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Navigation.Show(CalendarZoom.MONTH, "never"))
        assertEquals(CalendarZoom.DAY, vm.state.value.zoom)
        act(vm, CalendarAction.Navigation.Page(5))
        act(vm, CalendarAction.Navigation.GoToday)
        assertEquals("2026-10-16", vm.state.value.selectedDay)
        vm.close()
    }

    @Test fun `a tap opens the details of the item`() = runTest(dispatcher) {
        serve(MEETING, INVOICE)
        val vm = loaded()
        val effects = effectsOf(vm)
        act(vm, CalendarAction.Gesture.Tap("invoice"))
        assertEquals(CalendarEffect.OpenDetails("invoice", CalendarItemKind.TASK, "2026-10-16"), effects.single())
        vm.close()
    }

    @Test fun `a tap while another item is selected only deselects`() = runTest(dispatcher) {
        serve(MEETING, INVOICE)
        val vm = loaded()
        val effects = effectsOf(vm)
        act(vm, CalendarAction.Gesture.Select("meeting"))
        assertEquals("meeting", vm.state.value.selectedItemId)
        act(vm, CalendarAction.Gesture.Tap("invoice"))
        assertNull(vm.state.value.selectedItemId)
        assertTrue(effects.isEmpty())
        vm.close()
    }

    @Test fun `a tap on the selected item opens it and deselects`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        val effects = effectsOf(vm)
        act(vm, CalendarAction.Gesture.Select("meeting"))
        act(vm, CalendarAction.Gesture.Tap("meeting"))
        assertNull(vm.state.value.selectedItemId)
        assertEquals(1, effects.size)
        vm.close()
    }

    @Test fun `only an editable item can be selected and a tap beside deselects`() = runTest(dispatcher) {
        serve(MEETING, HOLIDAY)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.Select("holiday"))
        assertNull(vm.state.value.selectedItemId)
        act(vm, CalendarAction.Gesture.Select("missing"))
        assertNull(vm.state.value.selectedItemId)
        act(vm, CalendarAction.Gesture.Select("meeting"))
        act(vm, CalendarAction.Gesture.TapBackground)
        assertNull(vm.state.value.selectedItemId)
        vm.close()
    }

    @Test fun `dragging previews a snapped move that keeps the duration`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 14 * 60 + 8, false, null))
        val drag = vm.state.value.drag
        assertEquals(CalendarDrag("meeting", "2026-10-16", false, 14 * 60 + 15, 15 * 60 + 45, null, false), drag)
        assertEquals("meeting", vm.state.value.selectedItemId)
        vm.close()
    }

    @Test fun `dragging over the all day row previews an all day item`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-17", 0, true, null))
        val drag = vm.state.value.drag
        assertEquals(true, drag?.allDay)
        assertNull(drag?.startMinutes)
        assertEquals("2026-10-17", drag?.date)
        vm.close()
    }

    @Test fun `a task over an event is previewed as going into it and over itself is not`() = runTest(dispatcher) {
        serve(MEETING, INVOICE)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("invoice", "2026-10-16", 10 * 60, false, "meeting"))
        assertEquals("meeting", vm.state.value.drag?.intoEventId)
        act(vm, CalendarAction.Gesture.DragMove("invoice", "2026-10-16", 10 * 60, false, "invoice"))
        assertNull(vm.state.value.drag?.intoEventId)
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 10 * 60, false, "lunch"))
        assertNull(vm.state.value.drag?.intoEventId)
        vm.close()
    }

    @Test fun `a read only item or an unknown day cannot be dragged`() = runTest(dispatcher) {
        serve(MEETING, HOLIDAY)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("holiday", "2026-10-16", 600, false, null))
        act(vm, CalendarAction.Gesture.DragMove("meeting", "never", 600, false, null))
        act(vm, CalendarAction.Gesture.DragResize("holiday", CalendarEdge.END, 600))
        assertNull(vm.state.value.drag)
        vm.close()
    }

    @Test fun `handles resize in steps and never invert the item`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragResize("meeting", CalendarEdge.END, 12 * 60 + 5))
        assertEquals(10 * 60 to 12 * 60, vm.state.value.drag?.startMinutes to vm.state.value.drag?.endMinutes)
        act(vm, CalendarAction.Gesture.DragResize("meeting", CalendarEdge.END, 9 * 60))
        assertEquals(10 * 60 + 15, vm.state.value.drag?.endMinutes)
        act(vm, CalendarAction.Gesture.DragResize("meeting", CalendarEdge.START, 11 * 60 + 30))
        assertEquals(11 * 60 + 15, vm.state.value.drag?.startMinutes)
        assertEquals(11 * 60 + 30, vm.state.value.drag?.endMinutes)
        vm.close()
    }

    @Test fun `dropping a drag writes the previewed schedule and shows the new data`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-17", 15 * 60, false, null))
        serve(MEETING.copy(date = DAY_ZERO.plusDays(1)))
        act(vm, CalendarAction.Gesture.EndDrag(true))
        assertEquals(listOf("window", "reschedule meeting", "window"), repository.calls)
        assertEquals(schedule("15:00", "16:30", DAY_ZERO.plusDays(1)), repository.lastSchedule)
        assertNull(vm.state.value.drag)
        assertNull(vm.state.value.selectedItemId)
        assertFalse(vm.state.value.busy)
        assertTrue(vm.day("2026-10-17").items.any { it.id == "meeting" })
        vm.close()
    }

    @Test fun `a drop keeps its preview until the answer and refuses a second drag meanwhile`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 15 * 60, false, null))
        vm.onAction(CalendarAction.Gesture.EndDrag(true))
        assertEquals(true, vm.state.value.drag?.committing)
        assertTrue(vm.state.value.busy)
        vm.onAction(CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 8 * 60, false, null))
        assertEquals(15 * 60, vm.state.value.drag?.startMinutes)
        runCurrent()
        assertNull(vm.state.value.drag)
        vm.close()
    }

    @Test fun `a drop that the server refuses removes the preview and reports it`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        repository.writeResult = RepositoryResult.Failure(FailureKind.REJECTED)
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 15 * 60, false, null))
        act(vm, CalendarAction.Gesture.EndDrag(true))
        assertNull(vm.state.value.drag)
        assertFalse(vm.state.value.busy)
        assertTrue(vm.state.value.problem)
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        vm.close()
    }

    @Test fun `a drag that is cancelled writes nothing`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 15 * 60, false, null))
        act(vm, CalendarAction.Gesture.EndDrag(false))
        act(vm, CalendarAction.Gesture.EndDrag(true))
        assertNull(vm.state.value.drag)
        assertEquals(listOf("window"), repository.calls)
        vm.close()
    }

    @Test fun `dropping a task on an event puts it into the event`() = runTest(dispatcher) {
        serve(MEETING, INVOICE)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.DragMove("invoice", "2026-10-16", 10 * 60, false, "meeting"))
        act(vm, CalendarAction.Gesture.EndDrag(true))
        assertTrue("host invoice meeting" in repository.calls)
        assertTrue(repository.calls.none { it.startsWith("reschedule") })
        vm.close()
    }

    @Test fun `a series occurrence is moved through the repository`() = runTest(dispatcher) {
        serve(STANDUP)
        val vm = loaded()
        assertTrue(vm.item("series@2026-10-16").editable)
        act(vm, CalendarAction.Gesture.DragMove("series@2026-10-16", "2026-10-16", 8 * 60, false, null))
        act(vm, CalendarAction.Gesture.EndDrag(true))
        assertTrue("reschedule series@2026-10-16" in repository.calls)
        vm.close()
    }

    @Test fun `a task is done and open again`() = runTest(dispatcher) {
        serve(INVOICE, INVOICE.copy(id = "paid", status = "done"))
        val vm = loaded()
        act(vm, CalendarAction.Gesture.ToggleDone("invoice"))
        act(vm, CalendarAction.Gesture.ToggleDone("paid"))
        act(vm, CalendarAction.Gesture.ToggleDone("meeting"))
        assertEquals(listOf("done invoice true", "done paid false"), repository.calls.filter { it.startsWith("done") })
        assertTrue(vm.item("paid").done)
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

    @Test fun `an item dropped on a day of the month view moves there and keeps its time`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.MoveToDay("meeting", "2026-10-21"))
        assertEquals(schedule("10:00", "11:30", DAY_ZERO.plusDays(5)), repository.lastSchedule)
        act(vm, CalendarAction.Gesture.MoveToDay("meeting", "2026-10-16"))
        act(vm, CalendarAction.Gesture.MoveToDay("holiday", "2026-10-21"))
        act(vm, CalendarAction.Gesture.MoveToDay("meeting", "never"))
        assertEquals(1, repository.calls.count { it.startsWith("reschedule") })
        vm.close()
    }

    @Test fun `cut and paste move an item to the place that is held`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Edit.Cut("meeting"))
        assertEquals(CalendarClipboard(CalendarClipboardMode.CUT, "Title meeting"), vm.state.value.clipboard)
        act(vm, CalendarAction.Edit.Paste("2026-10-17", 9 * 60, false))
        assertEquals(schedule("09:00", "10:30", DAY_ZERO.plusDays(1)), repository.lastSchedule)
        assertTrue("reschedule meeting" in repository.calls)
        assertNull(vm.state.value.clipboard)
        act(vm, CalendarAction.Edit.Paste("2026-10-17", 9 * 60, false))
        assertEquals(1, repository.calls.count { it.startsWith("reschedule") })
        vm.close()
    }

    @Test fun `copy and paste duplicate an item and the clipboard stays`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Edit.Copy("meeting"))
        act(vm, CalendarAction.Edit.Paste("2026-10-18", 13 * 60, false))
        act(vm, CalendarAction.Edit.Paste("2026-10-19", 0, true))
        assertEquals(2, repository.calls.count { it == "duplicate meeting" })
        assertEquals(schedule(null, null, DAY_ZERO.plusDays(3)), repository.lastSchedule)
        assertEquals(CalendarClipboardMode.COPIED, vm.state.value.clipboard?.mode)
        vm.close()
    }

    @Test fun `pasting an all day item at a time gives it a default length`() = runTest(dispatcher) {
        serve(TRIP)
        val vm = loaded()
        act(vm, CalendarAction.Edit.Copy("trip"))
        act(vm, CalendarAction.Edit.Paste("2026-10-20", 8 * 60, false))
        assertEquals(schedule("08:00", "09:00", DAY_ZERO.plusDays(4)), repository.lastSchedule)
        act(vm, CalendarAction.Edit.Paste("2026-10-21", 0, true))
        assertEquals(DAY_ZERO.plusDays(5), repository.lastSchedule?.date)
        vm.close()
    }

    @Test fun `pasting with an empty clipboard or a bad day does nothing`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Edit.Paste("2026-10-17", 9 * 60, false))
        act(vm, CalendarAction.Edit.Copy("meeting"))
        act(vm, CalendarAction.Edit.Paste("never", 9 * 60, false))
        act(vm, CalendarAction.Edit.Copy("holiday"))
        assertEquals(listOf("window"), repository.calls)
        vm.close()
    }

    @Test fun `duplicate copies the item onto the same slot`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Edit.Duplicate("meeting"))
        assertTrue("duplicate meeting" in repository.calls)
        assertEquals(MEETING.schedule, repository.lastSchedule)
        vm.close()
    }

    @Test fun `delete closes the menu and asks a confirmation that can be given or refused`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Gesture.Select("meeting"))
        act(vm, CalendarAction.Edit.RequestDelete("meeting"))
        assertNull(vm.state.value.selectedItemId)
        val request = CalendarDeleteRequest("meeting", "Title meeting", CalendarItemKind.EVENT)
        assertEquals(request, vm.state.value.pendingDelete)
        act(vm, CalendarAction.Edit.CancelDelete)
        assertNull(vm.state.value.pendingDelete)
        assertTrue(repository.calls.none { it.startsWith("delete") })
        act(vm, CalendarAction.Edit.RequestDelete("meeting"))
        act(vm, CalendarAction.Edit.ConfirmDelete)
        assertTrue("delete meeting" in repository.calls)
        assertNull(vm.state.value.pendingDelete)
        vm.close()
    }

    @Test fun `a holiday cannot be deleted and a confirm without a request does nothing`() = runTest(dispatcher) {
        serve(HOLIDAY)
        val vm = loaded()
        act(vm, CalendarAction.Edit.RequestDelete("holiday"))
        assertNull(vm.state.value.pendingDelete)
        act(vm, CalendarAction.Edit.ConfirmDelete)
        assertEquals(listOf("window"), repository.calls)
        vm.close()
    }

    @Test fun `a change another screen made reloads the calendar`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        serve(MEETING, LUNCH)
        repository.changes.changed()
        runCurrent()
        assertEquals(2, vm.state.value.days.flatMap { it.items }.size)
        assertEquals(2, repository.calls.count { it == "window" })
        vm.close()
    }

    @Test fun `refresh reloads unless a drag is in progress`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        act(vm, CalendarAction.Navigation.Refresh)
        assertEquals(2, repository.calls.count { it == "window" })
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 15 * 60, false, null))
        act(vm, CalendarAction.Navigation.Refresh)
        assertEquals(2, repository.calls.count { it == "window" })
        vm.close()
    }

    @Test fun `the screens the calendar does not show itself are requested as effects`() = runTest(dispatcher) {
        serve(MEETING)
        val vm = loaded()
        val effects = effectsOf(vm)
        act(vm, CalendarAction.Open.Calendars)
        act(vm, CalendarAction.Open.Invitations)
        act(vm, CalendarAction.Open.NewItem("2026-10-17"))
        act(vm, CalendarAction.Open.Sleep("2026-10-16"))
        act(vm, CalendarAction.Open.Agenda("2026-10-16"))
        assertEquals(
            listOf(
                CalendarEffect.OpenCalendars,
                CalendarEffect.OpenInvitations,
                CalendarEffect.OpenNewItem("2026-10-17"),
                CalendarEffect.OpenSleep("2026-10-16"),
                CalendarEffect.OpenAgenda("2026-10-16"),
            ),
            effects,
        )
        vm.close()
    }

    @Test fun `hidden calendars leave their items out and a vanished item is deselected`() = runTest(dispatcher) {
        repository.onWindow = { _, _ ->
            val calendars = listOf(calendarInfo("work"), calendarInfo("tasks", hidden = true))
            RepositoryResult.Content(window(listOf(MEETING, INVOICE), calendars))
        }
        val vm = loaded()
        assertEquals(listOf("meeting"), vm.state.value.days.flatMap { it.items }.map { it.id })
        act(vm, CalendarAction.Gesture.Select("meeting"))
        repository.onWindow = { _, _ ->
            RepositoryResult.Content(window(emptyList(), listOf(calendarInfo("work", kind = CalendarKind.OWN))))
        }
        act(vm, CalendarAction.Navigation.Refresh)
        assertNull(vm.state.value.selectedItemId)
        vm.close()
    }

    private fun viewModel(changes: MutableSharedFlow<Unit>) =
        CalendarViewModelFactory(
            repository,
            FakeCatalogRepository(),
            FakeInvitationRepository(),
            repository.changes,
            ScriptedInternetAccountRepository(),
            changes,
        ).calendarViewModel("2026-10-16")

    @Test fun `a write elsewhere in the window reloads the calendar`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        serve(MEETING)
        val vm = viewModel(changes).also { runCurrent() }
        val windowReads = repository.calls.count { it == "window" }
        serve(MEETING, LUNCH)
        changes.emit(Unit)
        runCurrent()
        assertEquals(windowReads + 1, repository.calls.count { it == "window" })
        assertEquals("lunch", vm.item("lunch").id)
        vm.close()
    }

    @Test fun `a write elsewhere does not reload the calendar while an item is dragged`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        serve(MEETING)
        val vm = viewModel(changes).also { runCurrent() }
        act(vm, CalendarAction.Gesture.DragMove("meeting", "2026-10-16", 14 * 60, false, null))
        val windowReads = repository.calls.count { it == "window" }
        changes.emit(Unit)
        runCurrent()
        assertEquals(windowReads, repository.calls.count { it == "window" })
        vm.close()
    }
}
