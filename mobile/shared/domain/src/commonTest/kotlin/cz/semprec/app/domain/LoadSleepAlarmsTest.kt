package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LoadSleepAlarmsTest {
    private val today = CalendarDay(2026, 11, 25)

    private fun night(evening: CalendarDay, wake: String, alarm: Boolean, bed: String = "23:00") =
        SleepNight(evening, "p1", "Weekdays", time(bed), time(wake), alarm, changed = false, durationMinutes = 465)

    private fun repository(enabled: Boolean = true) = RecordingSleepRepository(
        RepositoryResult.Content(SleepOverview(sampleSettings().copy(enabled = enabled), emptyList(), null)),
    )

    @Test fun `the alarms of a week from last evening ring on the day after each evening`() = runTest {
        val repository = repository()
        repository.nightsResult = RepositoryResult.Content(
            listOf(
                night(today.plusDays(-1), "06:45", alarm = true),
                night(today, "07:00", alarm = false),
                night(today.plusDays(1), "08:30", alarm = true, bed = "00:00"),
            ),
        )

        val alarms = LoadSleepAlarms(repository)(today)

        assertEquals(
            RepositoryResult.Content(
                listOf(
                    SleepAlarm(today.plusDays(-1), today, time("06:45"), "Weekdays"),
                    SleepAlarm(today.plusDays(1), today.plusDays(2), time("08:30"), "Weekdays"),
                ),
            ),
            alarms,
        )
        assertEquals(listOf("overview:null", "nights:2026-11-24..2026-12-01"), repository.calls)
    }

    @Test fun `the plan switched off rings no alarm and reads no night`() = runTest {
        val repository = repository(enabled = false)

        assertEquals(RepositoryResult.Content(emptyList()), LoadSleepAlarms(repository)(today))
        assertTrue(repository.calls.none { it.startsWith("nights") })
    }

    @Test fun `a failed read of the settings or the nights is the failure`() = runTest {
        val noSettings = RecordingSleepRepository()
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), LoadSleepAlarms(noSettings)(today))

        val noNights = repository()
        noNights.nightsResult = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), LoadSleepAlarms(noNights)(today))
    }
}
