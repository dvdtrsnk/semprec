package cz.alldots.app.presentation

import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.SleepNightEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** The part of a night of sleep each day of the timeline draws. */
class CalendarSleepBandsTest {
    private val friday = DAY_ZERO
    private val saturday = DAY_ZERO.plusDays(1)

    private fun night(entry: CalendarEntry): SleepNightEntry = assertNotNull(entry.sleep)

    private fun band(state: CalendarSleep?) = state?.let { it.fromMinutes to it.toMinutes }

    @Test fun `an evening bedtime runs to midnight and the morning from midnight to wake time`() {
        val night = night(sleepEntry(friday))
        assertEquals(23 * 60 to 24 * 60, band(night.toState(friday)))
        assertEquals(22 * 60 + 30, night.toState(friday)?.prepMinutes)
        assertEquals(0 to 6 * 60 + 45, band(night.toState(saturday)))
        assertNull(night.toState(saturday)?.prepMinutes)
    }

    @Test fun `a bedtime at midnight puts the whole night on the wake day and keeps the reminder on the evening`() {
        val night = night(sleepEntry(friday, bed = "00:00", wake = "08:30", prep = "${friday}T23:30:00+02:00"))
        val evening = night.toState(friday)
        assertEquals(0 to 0, band(evening))
        assertEquals(23 * 60 + 30, evening?.prepMinutes)
        assertEquals(0 to 8 * 60 + 30, band(night.toState(saturday)))
    }

    @Test fun `a bedtime in the small hours runs from bedtime and a reminder after midnight is on the wake day`() {
        val night = night(sleepEntry(friday, bed = "01:00", wake = "09:00", prep = "${saturday}T00:30:00+02:00"))
        assertNull(night.toState(friday))
        assertEquals(60 to 9 * 60, band(night.toState(saturday)))
        assertEquals(30, night.toState(saturday)?.prepMinutes)
    }

    @Test fun `a morning bedtime after the wake time draws nothing`() {
        val night = night(sleepEntry(friday, bed = "10:00", wake = "09:00", prep = null))
        assertNull(night.toState(friday))
        assertNull(night.toState(saturday))
    }

    @Test fun `every day of a week with weekday and weekend schedules shows only its own sleep`() {
        // 2026-10-12 is a Monday. A night belongs to the schedule of its wake day: Sunday's to Monday's 23:00 to
        // 6:45, Friday's and Saturday's to the weekend's 0:00 to 8:30.
        val monday = CalendarDay(2026, 10, 12)
        val evenings = (-1..6).map { monday.plusDays(it) }
        val entries = evenings.map { evening ->
            val wakesOnWeekend = evening.plusDays(1).let { it == monday.plusDays(5) || it == monday.plusDays(6) }
            if (wakesOnWeekend) {
                sleepEntry(evening, bed = "00:00", wake = "08:30", prep = null)
            } else {
                sleepEntry(evening, bed = "23:00", wake = "06:45", prep = null)
            }
        }
        val days = dayStatesOf(entries, monday, monday.plusDays(6), CalendarColors(emptyList()))
        val bands = days.map { day ->
            listOfNotNull(day.sleepMorning, day.sleepEvening)
                .filter { it.toMinutes > it.fromMinutes }
                .map { it.fromMinutes to it.toMinutes }
        }
        val weekdayMorning = 0 to 6 * 60 + 45
        val weekdayEvening = 23 * 60 to 24 * 60
        val weekendMorning = 0 to 8 * 60 + 30
        assertEquals(
            listOf(
                listOf(weekdayMorning, weekdayEvening),
                listOf(weekdayMorning, weekdayEvening),
                listOf(weekdayMorning, weekdayEvening),
                listOf(weekdayMorning, weekdayEvening),
                listOf(weekdayMorning),
                listOf(weekendMorning),
                listOf(weekendMorning, weekdayEvening),
            ),
            bands,
        )
    }
}
