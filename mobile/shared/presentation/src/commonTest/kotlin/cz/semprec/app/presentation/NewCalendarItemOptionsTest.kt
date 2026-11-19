package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarRepeat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class NewCalendarItemOptionsTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository()

    private fun TestScope.loaded(): NewCalendarItemViewModel =
        CalendarViewModelFactory(repository, FakeCatalogRepository(), FakeInvitationRepository(), repository.changes)
            .newCalendarItemViewModel("2026-10-17")
            .also { runCurrent() }

    private fun create(
        kind: NewItemKind = NewItemKind.EVENT,
        endDay: String = "",
        start: Int = 10 * 60,
        end: Int = 11 * 60,
        alertMinutes: Int? = null,
        travelMinutes: Int? = null,
        repeat: NewItemRepeat = NewItemRepeat.NEVER,
    ) = NewItemAction.Create(
        kind, "Trip", "2026-10-17", true, start, true, end, "", "",
        endDay = endDay,
        notes = " Bring the map ",
        url = "https://example.com",
        alertMinutes = alertMinutes,
        travelMinutes = travelMinutes,
        repeat = repeat,
        flagged = true,
    )

    @Test fun `an event carries its notes url alert travel time repeat and later end day`() = runTest(dispatcher) {
        val vm = loaded()
        val overnight = create(endDay = "2026-10-19", start = 18 * 60, end = 9 * 60, alertMinutes = 25)
        vm.onAction(overnight.copy(travelMinutes = 45, repeat = NewItemRepeat.WEEKLY))
        runCurrent()
        val draft = repository.lastDraft!!
        assertEquals(CalendarDay(2026, 10, 19), draft.schedule.endDate)
        assertEquals("Bring the map", draft.notes)
        assertEquals("https://example.com", draft.url)
        assertEquals(25, draft.alertMinutes)
        assertEquals(45, draft.travelMinutes)
        assertEquals(CalendarRepeat.WEEKLY, draft.repeat)
        assertFalse(draft.flagged)
        vm.close()
    }

    @Test fun `a task keeps its notes flag and repeat and drops what belongs to an event`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(create(kind = NewItemKind.TASK, endDay = "2026-10-19", repeat = NewItemRepeat.YEARLY))
        runCurrent()
        val draft = repository.lastDraft!!
        assertNull(draft.schedule.endDate)
        assertEquals("Bring the map", draft.notes)
        assertNull(draft.url)
        assertTrue(draft.flagged)
        assertEquals(CalendarRepeat.YEARLY, draft.repeat)
        vm.close()
    }

    @Test fun `an end day before the start a yearly event or an alert out of range fails without the server`() =
        runTest(dispatcher) {
            val refused = listOf(
                create(endDay = "2026-10-16"),
                create(endDay = "someday"),
                create(repeat = NewItemRepeat.YEARLY),
                create(alertMinutes = -1),
                create(alertMinutes = 40_321),
                create(travelMinutes = 0),
                create(travelMinutes = 1_441),
            )
            for (action in refused) {
                val vm = loaded()
                vm.onAction(action)
                runCurrent()
                assertEquals(FailureKind.REJECTED, vm.state.value.failure, "$action")
                vm.close()
            }
            assertTrue(repository.calls.none { it.startsWith("create") })
        }

    @Test fun `custom alert and travel minutes at the ends of their ranges are kept`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(create(alertMinutes = 40_320, travelMinutes = 1_440))
        runCurrent()
        assertEquals(40_320, repository.lastDraft?.alertMinutes)
        assertEquals(1_440, repository.lastDraft?.travelMinutes)
        vm.close()
    }
}
