package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CalendarDayTest {
    @Test fun `a date round trips through text`() {
        assertEquals("2026-10-16", CalendarDay.parse("2026-10-16").toString())
        assertEquals("0999-01-05", CalendarDay(999, 1, 5).toString())
    }

    @Test fun `impossible and malformed dates are refused`() {
        assertNull(CalendarDay.parse("2026-02-30"))
        assertNull(CalendarDay.parse("2026-13-01"))
        assertNull(CalendarDay.parse("2026-1-01"))
        assertNull(CalendarDay.parse("abcd-ef-gh"))
        assertNull(CalendarDay.parse(""))
    }

    @Test fun `the epoch is a Thursday and day zero`() {
        val epoch = CalendarDay(1970, 1, 1)
        assertEquals(0L, epoch.epochDay)
        assertEquals(4, epoch.isoDayOfWeek)
    }

    @Test fun `weekdays follow the ISO numbering`() {
        assertEquals(5, CalendarDay(2026, 10, 16).isoDayOfWeek)
        assertEquals(7, CalendarDay(2026, 10, 18).isoDayOfWeek)
        assertEquals(1, CalendarDay(2026, 10, 12).isoDayOfWeek)
    }

    @Test fun `adding days crosses months years and leap days`() {
        assertEquals(CalendarDay(2026, 11, 1), CalendarDay(2026, 10, 31).plusDays(1))
        assertEquals(CalendarDay(2027, 1, 1), CalendarDay(2026, 12, 31).plusDays(1))
        assertEquals(CalendarDay(2028, 2, 29), CalendarDay(2028, 2, 28).plusDays(1))
        assertEquals(CalendarDay(2027, 3, 1), CalendarDay(2027, 2, 28).plusDays(1))
        assertEquals(CalendarDay(2026, 10, 9), CalendarDay(2026, 10, 16).plusDays(-7))
        assertEquals(CalendarDay(2025, 10, 16), CalendarDay(2026, 10, 16).plusDays(-365))
    }

    @Test fun `every day of a leap year round trips through its epoch day`() {
        var day = CalendarDay(2024, 1, 1)
        repeat(366) {
            assertEquals(day, CalendarDay.ofEpochDay(day.epochDay))
            day = day.plusDays(1)
        }
        assertEquals(CalendarDay(2025, 1, 1), day)
    }

    @Test fun `adding months keeps the day or clamps to the month end`() {
        assertEquals(CalendarDay(2026, 11, 30), CalendarDay(2026, 10, 30).plusMonths(1))
        assertEquals(CalendarDay(2026, 2, 28), CalendarDay(2026, 1, 31).plusMonths(1))
        assertEquals(CalendarDay(2025, 12, 15), CalendarDay(2026, 1, 15).plusMonths(-1))
        assertEquals(CalendarDay(2027, 1, 15), CalendarDay(2026, 10, 15).plusMonths(3))
    }

    @Test fun `the week starts on Monday`() {
        assertEquals(CalendarDay(2026, 10, 12), CalendarDay(2026, 10, 16).startOfWeek())
        assertEquals(CalendarDay(2026, 10, 12), CalendarDay(2026, 10, 18).startOfWeek())
        assertEquals(CalendarDay(2026, 10, 12), CalendarDay(2026, 10, 12).startOfWeek())
    }

    @Test fun `month helpers and ordering`() {
        assertEquals(CalendarDay(2026, 10, 1), CalendarDay(2026, 10, 16).startOfMonth())
        assertEquals(31, CalendarDay(2026, 10, 16).lengthOfMonth())
        assertEquals(29, CalendarDay(2028, 2, 1).lengthOfMonth())
        assertTrue(CalendarDay(2026, 10, 16) < CalendarDay(2026, 10, 17))
        assertTrue(CalendarDay(2027, 1, 1) > CalendarDay(2026, 12, 31))
    }

    @Test fun `the calendar window is the month grid with a week on each side`() {
        val october = CalendarDay(2026, 9, 21) to CalendarDay(2026, 11, 16)
        assertEquals(october, CalendarDay(2026, 10, 14).calendarWindow())
        assertEquals(october, CalendarDay(2026, 10, 31).calendarWindow())
        assertEquals(CalendarDay(2026, 5, 25) to CalendarDay(2026, 7, 20), CalendarDay(2026, 6, 1).calendarWindow())
    }
}
