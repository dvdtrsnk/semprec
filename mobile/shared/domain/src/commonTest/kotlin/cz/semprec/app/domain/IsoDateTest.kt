package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class IsoDateTest {
    private fun day(text: String): IsoDate = checkNotNull(IsoDate.parse(text))

    @Test fun `parses and prints a day`() {
        val date = day("2026-10-16")
        assertEquals(2026, date.year)
        assertEquals(10, date.month)
        assertEquals(16, date.day)
        assertEquals("2026-10-16", date.toString())
    }

    @Test fun `the epoch is a thursday and 2026-10-16 a friday`() {
        assertEquals(0, day("1970-01-01").epochDay)
        assertEquals(4, day("1970-01-01").dayOfWeek)
        assertEquals(5, day("2026-10-16").dayOfWeek)
        assertEquals(1, day("2026-10-19").dayOfWeek)
        assertEquals(7, day("2026-10-18").dayOfWeek)
    }

    @Test fun `adds days across months years and leap days`() {
        assertEquals("2026-11-01", day("2026-10-31").plusDays(1).toString())
        assertEquals("2027-01-01", day("2026-12-31").plusDays(1).toString())
        assertEquals("2028-02-29", day("2028-02-28").plusDays(1).toString())
        assertEquals("2027-03-01", day("2027-02-28").plusDays(1).toString())
        assertEquals("2026-10-09", day("2026-10-16").plusDays(-7).toString())
        assertEquals("1969-12-31", day("1970-01-01").plusDays(-1).toString())
    }

    @Test fun `counts the days between two days`() {
        assertEquals(3, day("2026-10-16").daysUntil(day("2026-10-19")))
        assertEquals(-3, day("2026-10-19").daysUntil(day("2026-10-16")))
        assertEquals(0, day("2026-10-16").daysUntil(day("2026-10-16")))
        assertTrue(day("2026-10-16") < day("2026-10-17"))
    }

    @Test fun `refuses text that is no calendar day`() {
        assertNull(IsoDate.parse("2026-02-30"))
        assertNull(IsoDate.parse("2026-13-01"))
        assertNull(IsoDate.parse("2026-1-1"))
        assertNull(IsoDate.parse("tomorrow"))
        assertNull(IsoDate.parse(""))
        assertNull(IsoDate.of(2026, 4, 31))
        assertEquals("2024-02-29", IsoDate.of(2024, 2, 29)?.toString())
        assertNull(IsoDate.of(2100, 2, 29))
    }
}
