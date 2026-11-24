package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ScheduleEditingTest {
    private val day = CalendarDay(2026, 10, 16)
    private val nextDay = CalendarDay(2026, 10, 17)

    private fun timed(from: String, to: String?) =
        CalendarSchedule(day, null, ClockTime.parse(from), to?.let { ClockTime.parse(it) })

    @Test fun `minutes snap to the nearest quarter of an hour`() {
        assertEquals(0, ScheduleEditing.snap(0))
        assertEquals(0, ScheduleEditing.snap(7))
        assertEquals(15, ScheduleEditing.snap(8))
        assertEquals(600, ScheduleEditing.snap(607))
        assertEquals(615, ScheduleEditing.snap(608))
    }

    @Test fun `snapping stays inside the day`() {
        assertEquals(0, ScheduleEditing.snap(-40))
        assertEquals(1440, ScheduleEditing.snap(1500))
    }

    @Test fun `a timed item keeps its duration when it moves`() {
        val moved = ScheduleEditing.moveTo(CalendarEntryKind.EVENT, timed("10:00", "11:30"), nextDay, 14 * 60 + 5)
        assertEquals(CalendarSchedule(nextDay, null, ClockTime(14 * 60), ClockTime(15 * 60 + 30)), moved)
    }

    @Test fun `a move late in the day keeps the end before midnight`() {
        val moved = ScheduleEditing.moveTo(CalendarEntryKind.EVENT, timed("10:00", "12:00"), day, 23 * 60)
        assertEquals(ClockTime(22 * 60), moved.timeFrom)
        assertEquals(ClockTime(24 * 60), moved.timeTo)
    }

    @Test fun `a move before midnight start is clamped to the first minute`() {
        val moved = ScheduleEditing.moveTo(CalendarEntryKind.TASK, timed("10:00", null), day, -100)
        assertEquals(ClockTime(0), moved.timeFrom)
        assertNull(moved.timeTo)
    }

    @Test fun `an all day event pulled into time lasts an hour`() {
        val allDay = CalendarSchedule(day, null, null, null)
        val moved = ScheduleEditing.moveTo(CalendarEntryKind.EVENT, allDay, day, 9 * 60)
        assertEquals(ClockTime(9 * 60), moved.timeFrom)
        assertEquals(ClockTime(10 * 60), moved.timeTo)
    }

    @Test fun `an all day task pulled into time gets no end`() {
        val allDay = CalendarSchedule(day, null, null, null)
        val moved = ScheduleEditing.moveTo(CalendarEntryKind.TASK, allDay, day, 9 * 60)
        assertEquals(ClockTime(9 * 60), moved.timeFrom)
        assertNull(moved.timeTo)
    }

    @Test fun `a timed item pulled into the all day row loses its times`() {
        val moved = ScheduleEditing.toAllDay(timed("10:00", "11:00"), nextDay)
        assertEquals(CalendarSchedule(nextDay, null, null, null), moved)
    }

    @Test fun `a multi day event keeps its span in the all day row`() {
        val span = CalendarSchedule(day, day.plusDays(2), null, null)
        assertEquals(day.plusDays(2), ScheduleEditing.toAllDay(span, day).endDate)
    }

    @Test fun `moving to another day shifts a multi day span with it`() {
        val span = CalendarSchedule(day, day.plusDays(1), null, null)
        val moved = ScheduleEditing.toDay(span, day.plusDays(7))
        assertEquals(day.plusDays(7), moved.date)
        assertEquals(day.plusDays(8), moved.endDate)
    }

    @Test fun `moving to another day keeps the time of day`() {
        val moved = ScheduleEditing.toDay(timed("10:00", "11:00"), nextDay)
        assertEquals(CalendarSchedule(nextDay, null, ClockTime(600), ClockTime(660)), moved)
    }

    @Test fun `the start handle never passes the end minus a step`() {
        val resized = ScheduleEditing.resizeStart(timed("10:00", "11:00"), 11 * 60)
        assertEquals(ClockTime(10 * 60 + 45), resized.timeFrom)
        assertEquals(ClockTime(11 * 60), resized.timeTo)
    }

    @Test fun `the start handle snaps and moves the start earlier`() {
        val resized = ScheduleEditing.resizeStart(timed("10:00", "11:00"), 9 * 60 + 40)
        assertEquals(ClockTime(9 * 60 + 45), resized.timeFrom)
    }

    @Test fun `the end handle never passes the start plus a step`() {
        val resized = ScheduleEditing.resizeEnd(timed("10:00", "11:00"), 9 * 60)
        assertEquals(ClockTime(10 * 60 + 15), resized.timeTo)
    }

    @Test fun `the end handle can reach midnight and no further`() {
        val resized = ScheduleEditing.resizeEnd(timed("20:00", "21:00"), 25 * 60)
        assertEquals(ClockTime(24 * 60), resized.timeTo)
    }

    @Test fun `resizing a task without an end gives it one`() {
        val resized = ScheduleEditing.resizeEnd(timed("10:00", null), 11 * 60)
        assertEquals(ClockTime(11 * 60), resized.timeTo)
    }

    @Test fun `the start handle of a task without an end keeps its short block`() {
        val resized = ScheduleEditing.resizeStart(timed("10:00", null), 9 * 60)
        assertEquals(ClockTime(9 * 60), resized.timeFrom)
        assertEquals(ClockTime(10 * 60 + 30), resized.timeTo)
    }

    @Test fun `an all day item has no handles`() {
        val allDay = CalendarSchedule(day, null, null, null)
        assertEquals(allDay, ScheduleEditing.resizeStart(allDay, 600))
        assertEquals(allDay, ScheduleEditing.resizeEnd(allDay, 600))
        assertNull(ScheduleEditing.visibleEnd(allDay))
    }

    @Test fun `a timed item without an end is drawn as a short block`() {
        assertEquals(10 * 60 + 30, ScheduleEditing.visibleEnd(timed("10:00", null)))
        assertEquals(24 * 60, ScheduleEditing.visibleEnd(timed("23:50", null)))
        assertEquals(60, ScheduleEditing.duration(timed("10:00", "11:00")))
        assertNull(ScheduleEditing.duration(timed("10:00", null)))
    }

    @Test fun `blocks that overlap share columns and blocks that touch do not`() {
        val lanes = layoutTimeline(listOf(600..660, 630..720, 660..700, 800..860))
        assertEquals(TimelineLane(0, 2), lanes[0])
        assertEquals(TimelineLane(1, 2), lanes[1])
        assertEquals(TimelineLane(0, 2), lanes[2])
        assertEquals(TimelineLane(0, 1), lanes[3])
    }

    @Test fun `three blocks at the same time take three columns`() {
        val lanes = layoutTimeline(listOf(540..600, 540..600, 540..600))
        assertEquals(listOf(0, 1, 2), lanes.map { it.column })
        assertEquals(listOf(3, 3, 3), lanes.map { it.columns })
    }

    @Test fun `a block that starts well after the one it overlaps is drawn over it in the same column`() {
        // 11:00-12:00, 11:45-12:45 and 12:30-13:30: each starts 45 minutes after the one before.
        val lanes = layoutTimeline(listOf(660..720, 705..765, 750..810))
        assertEquals(listOf(0, 0, 0), lanes.map { it.column })
        assertEquals(listOf(1, 1, 1), lanes.map { it.columns })
        assertEquals(listOf(0, 1, 2), lanes.map { it.depth })
    }

    @Test fun `a block that starts soon after the one it overlaps stands beside it`() {
        val lanes = layoutTimeline(listOf(540..600, 570..630))
        assertEquals(listOf(TimelineLane(0, 2, 0), TimelineLane(1, 2, 0)), lanes)
    }

    @Test fun `the start that separates a column from a cascade is 33 minutes after the other`() {
        assertEquals(1, layoutTimeline(listOf(540..600, 572..640))[1].column)
        assertEquals(0, layoutTimeline(listOf(540..600, 573..640))[1].column)
    }

    @Test fun `blocks nested in a long one use its column when they start late and the next column when they start soon`() {
        // 14:00-18:00 with 14:30-15:30, 15:00-16:00 and 15:15-15:30 inside it.
        val lanes = layoutTimeline(listOf(840..1080, 870..930, 900..960, 915..930))
        assertEquals(listOf(0, 1, 0, 1), lanes.map { it.column })
        assertEquals(listOf(2, 2, 2, 2), lanes.map { it.columns })
        assertEquals(listOf(0, 0, 1, 1), lanes.map { it.depth })
    }

    @Test fun `a block shorter than the minimum is laid out as long as the minimum`() {
        // The five-minute block at 08:00 would end before the one at 08:10 starts, but they would be drawn over each other.
        val lanes = layoutTimeline(listOf(480..485, 490..520))
        assertEquals(listOf(TimelineLane(0, 2, 0), TimelineLane(1, 2, 0)), lanes)
    }

    @Test fun `no blocks give no lanes`() {
        assertEquals(emptyList(), layoutTimeline(emptyList()))
    }
}
