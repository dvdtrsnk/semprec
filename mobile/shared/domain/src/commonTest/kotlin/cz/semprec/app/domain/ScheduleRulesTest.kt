package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ScheduleRulesTest {
    private val timed = Schedule("2026-10-16", "14:00", "15:30")

    @Test fun `reads and prints times`() {
        assertEquals(540, ScheduleRules.minutes("9:00"))
        assertEquals(540, ScheduleRules.minutes("09:00"))
        assertNull(ScheduleRules.minutes("9"))
        assertNull(ScheduleRules.minutes(null))
        assertEquals("09:05", ScheduleRules.time(545))
        assertEquals("23:55", ScheduleRules.time(24 * 60))
        assertEquals("00:00", ScheduleRules.time(-5))
    }

    @Test fun `the length follows from start and end`() {
        assertEquals(90, ScheduleRules.lengthMinutes(timed))
        assertNull(ScheduleRules.lengthMinutes(timed.copy(timeTo = null)))
        assertNull(ScheduleRules.lengthMinutes(timed.copy(timeFrom = null)))
    }

    @Test fun `removing the date removes every time`() {
        assertEquals(Schedule(null, null, null), ScheduleRules.withDate(timed, null))
    }

    @Test fun `a new date keeps the times and drops an end day before it`() {
        val event = timed.copy(endDate = "2026-10-18")
        assertEquals(event.copy(date = "2026-10-17"), ScheduleRules.withDate(event, "2026-10-17"))
        assertEquals(timed.copy(date = "2026-10-20", endDate = null), ScheduleRules.withDate(event, "2026-10-20"))
    }

    @Test fun `a new start moves the end by the same length`() {
        assertEquals(Schedule("2026-10-16", "16:00", "17:30"), ScheduleRules.withTimeFrom(timed, "16:00"))
        val short = timed.copy(timeTo = null)
        assertEquals(Schedule("2026-10-16", "09:00", null), ScheduleRules.withTimeFrom(short, "9:00"))
    }

    @Test fun `removing the start removes the end`() {
        assertEquals(Schedule("2026-10-16", null, null), ScheduleRules.withTimeFrom(timed, null))
    }

    @Test fun `an end is never before the start`() {
        assertEquals("14:05", ScheduleRules.withTimeTo(timed, "13:00").timeTo)
        assertEquals("14:05", ScheduleRules.withTimeTo(timed, "14:00").timeTo)
        assertEquals("18:00", ScheduleRules.withTimeTo(timed, "18:00").timeTo)
        assertNull(ScheduleRules.withTimeTo(timed, null).timeTo)
    }

    @Test fun `an end without a start changes nothing`() {
        val allDay = Schedule("2026-10-16", null, null)
        assertEquals(allDay, ScheduleRules.withTimeTo(allDay, "10:00"))
        assertEquals(allDay, ScheduleRules.withDefaultEnd(allDay))
    }

    @Test fun `the switches use the defaults of the board`() {
        assertEquals("14:30", ScheduleRules.withDefaultEnd(timed.copy(timeTo = null)).timeTo)
        val allDay = Schedule("2026-10-16", null, null)
        assertEquals(Schedule("2026-10-16", "09:00", null), ScheduleRules.withDefaultStart(allDay))
        assertEquals(Schedule(null, null, null), ScheduleRules.withDefaultStart(Schedule(null, null, null)))
    }

    @Test fun `an event is all day or runs for an hour from nine`() {
        assertEquals(Schedule("2026-10-16", null, null), ScheduleRules.withAllDay(timed, allDay = true))
        assertEquals(
            Schedule("2026-10-16", "09:00", "10:00"),
            ScheduleRules.withAllDay(Schedule("2026-10-16", null, null), allDay = false),
        )
    }
}
