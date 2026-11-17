package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class JournalPeriodTest {
    private val day = CalendarDay(2026, 10, 16)

    @Test fun `period keys are the canonical spelling`() {
        assertEquals("2026", JournalPeriod.containing(JournalPeriodType.YEAR, day).key)
        assertEquals("2026-Q4", JournalPeriod.containing(JournalPeriodType.QUARTER, day).key)
        assertEquals("2026-10", JournalPeriod.containing(JournalPeriodType.MONTH, day).key)
        assertEquals("2026-W42", JournalPeriod.containing(JournalPeriodType.WEEK, day).key)
        assertEquals("2026-10-16", JournalPeriod.containing(JournalPeriodType.DAY, day).key)
    }

    @Test fun `the ISO week follows the year of its Thursday`() {
        assertEquals(IsoWeek(2026, 53), CalendarDay(2027, 1, 1).isoWeek())
        assertEquals(IsoWeek(2025, 1), CalendarDay(2024, 12, 30).isoWeek())
        assertEquals(IsoWeek(2026, 1), CalendarDay(2026, 1, 1).isoWeek())
        assertEquals(IsoWeek(2026, 42), CalendarDay(2026, 10, 12).isoWeek())
    }

    @Test fun `periods start on their first day and end on their last`() {
        assertEquals(CalendarDay(2026, 10, 1), day.startOf(JournalPeriodType.QUARTER))
        assertEquals(CalendarDay(2026, 12, 31), day.endOf(JournalPeriodType.QUARTER))
        assertEquals(CalendarDay(2026, 1, 1), day.startOf(JournalPeriodType.YEAR))
        assertEquals(CalendarDay(2026, 10, 31), day.endOf(JournalPeriodType.MONTH))
        assertEquals(CalendarDay(2026, 10, 12), day.startOf(JournalPeriodType.WEEK))
        assertEquals(CalendarDay(2026, 10, 18), day.endOf(JournalPeriodType.WEEK))
        assertEquals(CalendarDay(2026, 3, 31), CalendarDay(2026, 2, 3).endOf(JournalPeriodType.QUARTER))
        assertEquals(day, day.startOf(JournalPeriodType.DAY))
    }

    @Test fun `the axis marks the path of the selection and today`() {
        val rows = journalAxis(JournalPeriodType.DAY, day, CalendarDay(2026, 10, 17))
        assertEquals(JOURNAL_AXIS_LEVELS, rows.map { it.type })
        rows.forEach { row ->
            assertEquals(1, row.cells.count { it.onPath }, row.type.name)
        }
        val daysRow = rows.last().cells
        assertEquals(day, daysRow.single { it.current }.start)
        assertEquals(CalendarDay(2026, 10, 17), daysRow.single { it.today }.start)
        assertTrue(rows.first().cells.single { it.today }.start.year == 2026)
        assertFalse(rows[2].cells.any { it.current })
    }

    @Test fun `a wider selection has no path below its level`() {
        val rows = journalAxis(JournalPeriodType.MONTH, CalendarDay(2026, 10, 1), day)
        assertEquals(listOf(true, true, true, false), rows.map { row -> row.cells.any { it.onPath } })
        assertEquals(CalendarDay(2026, 10, 1), rows[2].cells.single { it.current }.start)
    }

    @Test fun `every row is a window around the selection`() {
        val rows = journalAxis(JournalPeriodType.QUARTER, CalendarDay(2026, 10, 1), day)
        assertEquals(13, rows[0].cells.size)
        assertEquals(28, rows[1].cells.size)
        assertEquals(60, rows[2].cells.size)
        assertEquals(CalendarDay(2025, 1, 1), rows[3].cells.first().start)
        assertEquals(CalendarDay(2027, 12, 31), rows[3].cells.last().start)
        assertEquals(365 + 365 + 365, rows[3].cells.size)
        rows.dropLast(1).forEach { row ->
            assertTrue(row.cells.first().start <= rows[3].cells.first().start, row.type.name)
            assertTrue(row.cells.last().start >= CalendarDay(2027, 10, 1), row.type.name)
        }
    }
}
