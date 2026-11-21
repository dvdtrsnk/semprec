package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

private val DAY = CalendarDay(2026, 10, 16)

internal fun entry(
    id: String = "e1",
    kind: CalendarEntryKind = CalendarEntryKind.EVENT,
    calendarId: String? = "work",
    schedule: CalendarSchedule = CalendarSchedule(DAY, null, ClockTime(600), ClockTime(660)),
    readOnly: Boolean = false,
    seriesId: String? = null,
    status: String? = null,
) = CalendarEntry(
    id = id,
    kind = kind,
    title = "Title $id",
    calendarId = calendarId,
    date = schedule.date,
    endDate = schedule.endDate,
    timeFrom = schedule.timeFrom,
    timeTo = schedule.timeTo,
    effectiveTo = schedule.timeTo,
    allDay = schedule.timeFrom == null,
    status = status,
    place = null,
    readOnly = readOnly,
    version = "4",
    seriesId = seriesId,
)

internal fun calendar(
    id: String,
    hidden: Boolean = false,
    kind: CalendarKind = CalendarKind.OWN,
    isDefault: Boolean = false,
) =
    CalendarInfo(id, "Calendar $id", "#007AFF", true, hidden, isDefault, kind, null, "2026-10-16T08:00:00.000Z")

/** Records the writes it is asked for and answers a scripted window. */
internal class RecordingCalendarRepository(
    private val window: CalendarWindow? = null,
    private val createAnswer: RepositoryResult<String> = RepositoryResult.Content("new"),
) : CalendarRepository {
    val calls = mutableListOf<String>()
    var lastRange: Pair<CalendarDay, CalendarDay>? = null

    override suspend fun window(from: CalendarDay, to: CalendarDay): RepositoryResult<CalendarWindow> {
        lastRange = from to to
        calls += "window"
        return window?.let { RepositoryResult.Content(it) } ?: RepositoryResult.Failure(FailureKind.UNAVAILABLE)
    }

    override suspend fun reschedule(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<Unit> {
        calls += "reschedule ${entry.id}"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun setTaskDone(entry: CalendarEntry, done: Boolean): RepositoryResult<Unit> {
        calls += "done ${entry.id} $done"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun putTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit> {
        calls += "host ${task.id} ${event.id}"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun duplicate(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<String> {
        calls += "duplicate ${entry.id}"
        return RepositoryResult.Content("copy")
    }

    override suspend fun delete(entry: CalendarEntry): RepositoryResult<Unit> {
        calls += "delete ${entry.id}"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun create(draft: NewCalendarItem): RepositoryResult<String> {
        calls += "create ${draft.title}|${draft.place}|${draft.submissionKey}"
        return createAnswer
    }
}

class CalendarUseCasesTest {
    private fun timeline(vararg entries: CalendarEntry) =
        CalendarTimeline("Europe/Prague", DAY, 800, DAY, DAY, entries.toList())

    @Test fun `the window leaves out the entries of hidden calendars`() = runTest {
        val window = CalendarWindow(
            timeline(entry("a", calendarId = "work"), entry("b", calendarId = "family"), entry("c", calendarId = null)),
            listOf(calendar("work", hidden = true), calendar("family")),
            2,
        )
        val result = LoadCalendarWindow(RecordingCalendarRepository(window))(DAY, DAY)
        assertIs<RepositoryResult.Content<CalendarWindow>>(result)
        assertEquals(listOf("b", "c"), result.value.timeline.entries.map { it.id })
        assertEquals(2, result.value.pendingInvitations)
    }

    @Test fun `hiding the sleep and tasks calendars hides the entries that follow them`() = runTest {
        val sleepNight = entry("s", kind = CalendarEntryKind.SLEEP, calendarId = null)
        val trace = entry("tr", kind = CalendarEntryKind.TRACE, calendarId = null)
        val kept = entry("k", calendarId = null)
        val calendars = listOf(
            calendar("c-sleep", hidden = true, kind = CalendarKind.SYSTEM).copy(systemKey = "sleep"),
            calendar("c-tasks", hidden = false, kind = CalendarKind.SYSTEM).copy(systemKey = "tasks"),
        )
        val window = CalendarWindow(timeline(sleepNight, trace, kept), calendars, 0)
        val result = LoadCalendarWindow(RecordingCalendarRepository(window))(DAY, DAY)
        assertEquals(
            listOf("tr", "k"),
            assertIs<RepositoryResult.Content<CalendarWindow>>(result).value.timeline.entries.map {
                it.id
            }
        )
        val tasksHidden = window.copy(calendars = listOf(calendars[1].copy(hidden = true)))
        val second = LoadCalendarWindow(RecordingCalendarRepository(tasksHidden))(DAY, DAY)
        assertEquals(
            listOf("s", "k"),
            assertIs<RepositoryResult.Content<CalendarWindow>>(second).value.timeline.entries.map {
                it.id
            }
        )
    }

    @Test fun `a range longer than the server serves is refused without a request`() = runTest {
        val repository = RecordingCalendarRepository()
        val result = LoadCalendarWindow(repository)(DAY, DAY.plusDays(CALENDAR_MAX_WINDOW_DAYS))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), result)
        val backwards = LoadCalendarWindow(repository)(DAY, DAY.plusDays(-1))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), backwards)
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `a window of the longest allowed range is requested`() = runTest {
        val repository = RecordingCalendarRepository(CalendarWindow(timeline(), emptyList(), 0))
        LoadCalendarWindow(repository)(DAY, DAY.plusDays(CALENDAR_MAX_WINDOW_DAYS - 1))
        assertEquals(DAY to DAY.plusDays(CALENDAR_MAX_WINDOW_DAYS - 1), repository.lastRange)
    }

    @Test fun `a failing window passes its failure on`() = runTest {
        val result = LoadCalendarWindow(RecordingCalendarRepository())(DAY, DAY)
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), result)
    }

    @Test fun `only stored events and tasks and series occurrences can be edited`() {
        assertTrue(entry().isEditable)
        assertTrue(entry(kind = CalendarEntryKind.TASK).isEditable)
        assertTrue(entry(readOnly = true, seriesId = "s").isEditable)
        assertEquals(false, entry(readOnly = true).isEditable)
        assertEquals(false, entry(kind = CalendarEntryKind.HOLIDAY).isEditable)
        assertEquals(false, entry(kind = CalendarEntryKind.SLEEP).isEditable)
    }

    @Test fun `a move is written and an unchanged schedule is not`() = runTest {
        val repository = RecordingCalendarRepository()
        val edit = EditCalendarEntry(repository)
        val moved = entry().schedule.copy(timeFrom = ClockTime(700), timeTo = ClockTime(760))
        assertEquals(RepositoryResult.Content(Unit), edit.reschedule(entry(), moved))
        assertEquals(RepositoryResult.Content(Unit), edit.reschedule(entry(), entry().schedule))
        assertEquals(listOf("reschedule e1"), repository.calls)
    }

    @Test fun `a read only entry is refused every write`() = runTest {
        val repository = RecordingCalendarRepository()
        val edit = EditCalendarEntry(repository)
        val fixed = entry(readOnly = true)
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(refused, edit.reschedule(fixed, fixed.schedule.copy(timeFrom = ClockTime(1))))
        assertEquals(refused, edit.delete(fixed))
        assertEquals(refused, edit.duplicate(fixed, fixed.schedule))
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `only a task can be done and it flips`() = runTest {
        val repository = RecordingCalendarRepository()
        val edit = EditCalendarEntry(repository)
        edit.toggleDone(entry(id = "t", kind = CalendarEntryKind.TASK))
        edit.toggleDone(entry(id = "u", kind = CalendarEntryKind.TASK, status = "done"))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edit.toggleDone(entry()))
        assertEquals(listOf("done t true", "done u false"), repository.calls)
    }

    @Test fun `a task goes into an event and nothing else does`() = runTest {
        val repository = RecordingCalendarRepository()
        val edit = EditCalendarEntry(repository)
        val task = entry(id = "t", kind = CalendarEntryKind.TASK)
        assertEquals(RepositoryResult.Content(Unit), edit.putTaskInEvent(task, entry(id = "ev")))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edit.putTaskInEvent(entry(), entry(id = "ev")))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edit.putTaskInEvent(task, task))
        assertEquals(listOf("host t ev"), repository.calls)
    }

    @Test fun `a copy and a delete reach the repository for an editable entry`() = runTest {
        val repository = RecordingCalendarRepository()
        val edit = EditCalendarEntry(repository)
        assertEquals(RepositoryResult.Content("copy"), edit.duplicate(entry(), entry().schedule))
        assertEquals(RepositoryResult.Content(Unit), edit.delete(entry()))
        assertEquals(listOf("duplicate e1", "delete e1"), repository.calls)
    }

    @Test fun `a new item needs a title and an event or a task`() = runTest {
        val repository = RecordingCalendarRepository()
        val create = CreateCalendarItem(repository)
        val schedule = CalendarSchedule(DAY, null, null, null)
        val breaks = RepositoryResult.Content(NewCalendarItemOutcome.BreaksRules)
        assertEquals(breaks, create(NewCalendarItem(EVENT, "  ", schedule, null, null, submissionKey = "k1")))
        assertEquals(breaks, create(NewCalendarItem(HOLIDAY, "Day", schedule, null, null, submissionKey = "k2")))
        val task = NewCalendarItem(CalendarEntryKind.TASK, " Pay ", schedule, " ", null, submissionKey = "k3")
        assertEquals(RepositoryResult.Content(NewCalendarItemOutcome.Created("new")), create(task))
        assertEquals(listOf("create Pay|null|k3"), repository.calls)
    }

    @Test fun `a new item's title is created on one line`() = runTest {
        val repository = RecordingCalendarRepository()
        val schedule = CalendarSchedule(DAY, null, null, null)
        val draft = NewCalendarItem(EVENT, "Lunch\nwith Eva\n", schedule, null, null, submissionKey = "k")
        CreateCalendarItem(repository)(draft)
        assertEquals(listOf("create Lunch with Eva|null|k"), repository.calls)
    }

    @Test fun `a refusal by the server stays a failure and is not a form that breaks the rules`() = runTest {
        val repository = RecordingCalendarRepository(createAnswer = RepositoryResult.Failure(FailureKind.REJECTED))
        val schedule = CalendarSchedule(DAY, null, null, null)
        val draft = NewCalendarItem(EVENT, "Lunch", schedule, null, "cal-w", submissionKey = "k")
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), CreateCalendarItem(repository)(draft))
    }
}

private val EVENT = CalendarEntryKind.EVENT
private val HOLIDAY = CalendarEntryKind.HOLIDAY
