package cz.semprec.app.presentation

import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarTodayNavigationTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository().apply {
        onWindow = { _, _ -> RepositoryResult.Content(window(emptyList(), listOf(calendarInfo("work")), 0)) }
    }

    @Test fun `today shows its year or month and one level deeper when that is already shown`() =
        runTest(dispatcher) {
            val vm = CalendarViewModelFactory(
                repository,
                FakeCatalogRepository(),
                FakeInvitationRepository(),
                repository.changes,
                ScriptedInternetAccountRepository(),
            ).calendarViewModel("2026-10-16")
            runCurrent()
            val cases = listOf(
                Triple(CalendarZoom.YEAR, "2025-03-04", CalendarZoom.YEAR),
                Triple(CalendarZoom.YEAR, "2026-03-04", CalendarZoom.MONTH),
                Triple(CalendarZoom.MONTH, "2026-03-04", CalendarZoom.MONTH),
                Triple(CalendarZoom.MONTH, "2026-10-02", CalendarZoom.DAY),
                Triple(CalendarZoom.DAY, "2026-03-04", CalendarZoom.DAY),
            )
            for ((zoom, day, expected) in cases) {
                vm.onAction(CalendarAction.Navigation.Show(zoom, day))
                vm.onAction(CalendarAction.Navigation.GoToday)
                runCurrent()
                assertEquals(expected, vm.state.value.zoom, "$zoom on $day")
                assertEquals("2026-10-16", vm.state.value.selectedDay, "$zoom on $day")
            }
            vm.close()
        }
}
