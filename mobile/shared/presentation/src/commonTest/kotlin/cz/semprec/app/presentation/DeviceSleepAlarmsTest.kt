package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNight
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeviceSleepAlarmsTest {
    private fun alarms(repository: FakeSleepRepository) = DeviceSleepAlarmsFactory(repository).deviceSleepAlarms()

    @Test fun `the alarms carry their wake day time and plan`() = runTest {
        val repository = FakeSleepRepository(sleepContent())
        repository.nightsAnswer = RepositoryResult.Content(
            listOf(
                SleepNight(
                    CalendarDay(2026, 11, 24), "p1", "Weekdays", ClockTime(23 * 60), ClockTime(6 * 60 + 45),
                    alarm = true, changed = false, durationMinutes = 465,
                ),
            ),
        )

        assertEquals(
            listOf(DeviceSleepAlarm("2026-11-24", "2026-11-25", 6 * 60 + 45, "Weekdays")),
            alarms(repository).alarms("2026-11-25"),
        )
    }

    @Test fun `a failed read a crash or a malformed day is no answer`() = runTest {
        val failed = FakeSleepRepository(sleepUnavailable())
        val crashed = FakeSleepRepository(sleepContent(), crash = true)

        assertNull(alarms(failed).alarms("2026-11-25"))
        assertNull(alarms(crashed).alarms("2026-11-25"))
        assertNull(alarms(FakeSleepRepository(sleepContent())).alarms("not a day"))
    }

    @Test fun `only the sleep resync push asks for the alarms`() {
        val alarms = alarms(FakeSleepRepository(sleepContent()))

        assertTrue(alarms.asksForSleepAlarms(mapOf("kind" to "sleepResync")))
        assertFalse(alarms.asksForSleepAlarms(mapOf("kind" to "remindersResync")))
        assertFalse(alarms.asksForSleepAlarms(emptyMap()))
    }
}
