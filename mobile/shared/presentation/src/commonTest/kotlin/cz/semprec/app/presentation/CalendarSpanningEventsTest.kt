package cz.semprec.app.presentation

import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val LATE = entry("late", schedule = schedule("23:00", "00:30", endDay = DAY_ZERO.plusDays(1)))
private val LONG_STAY = entry("stay", schedule = schedule("12:00", "13:00", endDay = DAY_ZERO.plusDays(1)))

/** Events that run past midnight: on the timeline of each of their days, or in the all-day row. */
@OptIn(ExperimentalCoroutinesApi::class)
class CalendarSpanningEventsTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository()

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
        ).calendarViewModel("2026-10-16").also { runCurrent() }

    private fun CalendarViewModel.day(date: String): CalendarDayState = state.value.days.first { it.date == date }

    @Test fun `an event over midnight is drawn to midnight on its first day and from it on its last`() =
        runTest(dispatcher) {
            serve(LATE)
            val vm = loaded()
            val first = vm.day("2026-10-16").items.single()
            val last = vm.day("2026-10-17").items.single()
            assertFalse(first.allDay)
            assertEquals(23 * 60 to 24 * 60, first.startMinutes to first.endMinutes)
            assertFalse(first.hasEnd)
            assertFalse(last.allDay)
            assertEquals(0 to 30, last.startMinutes to last.endMinutes)
            assertTrue(last.hasEnd)
            vm.close()
        }

    @Test fun `an event that lasts longer than a day with times stays in the all day row`() = runTest(dispatcher) {
        serve(LONG_STAY)
        val vm = loaded()
        assertTrue(vm.day("2026-10-16").items.single().allDay)
        assertTrue(vm.day("2026-10-17").items.single().allDay)
        vm.close()
    }
}
