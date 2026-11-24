package cz.semprec.app.domain

/**
 * What moving and resizing an item of the calendar means, decided once for events and tasks alike (Principles,
 * "Čas a termíny"): steps are 15 minutes, a move keeps the duration, a resize never makes the item shorter than one
 * step, an all-day item is pulled into time with a default length and a timed one is pulled into the all-day row
 * without times. The gesture layer only reports where the finger is, as raw minutes.
 */
object ScheduleEditing {
    /** The step every start and end snaps to. */
    const val STEP_MINUTES: Int = 15

    /** How long an event pulled out of the all-day row lasts; a task keeps no end. */
    const val DEFAULT_EVENT_MINUTES: Int = 60

    /** How tall a timed item without an end is drawn: a short block. */
    const val SHORT_BLOCK_MINUTES: Int = 30

    private const val DAY_MINUTES = ClockTime.DAY_MINUTES

    /** [minutes] rounded to the nearest step and kept inside the day. */
    fun snap(minutes: Int): Int {
        val steps = (minutes + STEP_MINUTES / 2).floorDiv(STEP_MINUTES)
        return (steps * STEP_MINUTES).coerceIn(0, DAY_MINUTES)
    }

    /** The minutes a timed [schedule] lasts on its day, or `null` when it has no end. */
    fun duration(schedule: CalendarSchedule): Int? {
        val from = schedule.timeFrom
        val to = schedule.timeTo
        return if (from == null || to == null) null else to.minutes - from.minutes
    }

    /**
     * The end a timed item is drawn to: its end, or a short block after its start. Never later than midnight.
     */
    fun visibleEnd(schedule: CalendarSchedule): Int? {
        val from = schedule.timeFrom ?: return null
        val to = schedule.timeTo?.minutes ?: (from.minutes + SHORT_BLOCK_MINUTES)
        return minOf(to, DAY_MINUTES)
    }

    /**
     * Moves a single-day item so that it starts at [rawStart] (snapped). A timed item keeps its duration, so the
     * start is kept low enough for the end to stay inside the day; an all-day item becomes timed.
     */
    fun moveTo(kind: CalendarEntryKind, schedule: CalendarSchedule, day: CalendarDay, rawStart: Int): CalendarSchedule {
        val length = if (schedule.allDay) defaultLength(kind) else duration(schedule)
        val visible = length ?: SHORT_BLOCK_MINUTES
        val start = snap(rawStart).coerceAtMost(DAY_MINUTES - visible)
        val end = length?.let { start + it }
        return CalendarSchedule(day, null, ClockTime(start), end?.let { ClockTime(it) })
    }

    /** Pulls an item into the all-day row: the times go, a multi-day span stays. */
    fun toAllDay(schedule: CalendarSchedule, day: CalendarDay): CalendarSchedule =
        CalendarSchedule(day, schedule.endDate?.takeIf { it > day }, null, null)

    /** Moves an item to [day] and keeps its time of day; a multi-day event keeps its length in days. */
    fun toDay(schedule: CalendarSchedule, day: CalendarDay): CalendarSchedule {
        val shift = (day.epochDay - schedule.date.epochDay).toInt()
        return schedule.copy(date = day, endDate = schedule.endDate?.plusDays(shift))
    }

    /**
     * Drags the start edge to [rawStart]. The start stays at least one step before the end; an item with no end
     * keeps the end of its short block as its end, so the edge has something to stay in front of.
     */
    fun resizeStart(schedule: CalendarSchedule, rawStart: Int): CalendarSchedule {
        val end = visibleEnd(schedule) ?: return schedule
        val start = snap(rawStart).coerceIn(0, end - STEP_MINUTES)
        return schedule.copy(timeFrom = ClockTime(start), timeTo = ClockTime(end))
    }

    /** Drags the end edge to [rawEnd]; the end stays at least one step after the start and inside the day. */
    fun resizeEnd(schedule: CalendarSchedule, rawEnd: Int): CalendarSchedule {
        val start = schedule.timeFrom ?: return schedule
        val end = snap(rawEnd).coerceIn(start.minutes + STEP_MINUTES, DAY_MINUTES)
        return schedule.copy(timeTo = ClockTime(end))
    }

    private fun defaultLength(kind: CalendarEntryKind): Int? =
        if (kind == CalendarEntryKind.EVENT) DEFAULT_EVENT_MINUTES else null
}

/**
 * One block of a day's timeline. It sits in [column] of the [columns] its group of overlapping blocks is divided
 * into, and [depth] steps in from the left edge of that column when a block that started well before it lies under
 * it (a cascade), zero otherwise.
 */
data class TimelineLane(val column: Int, val columns: Int, val depth: Int = 0)

/** The shortest a block counts for when blocks are laid out, so a one-minute event still claims a readable chip. */
const val MIN_BLOCK_MINUTES: Int = 24

/**
 * How much later than an overlapped block a block starts to be drawn over it, indented, rather than beside it. A block
 * that starts sooner than this after another leaves the other's title and time uncovered only beside it.
 */
const val CASCADE_AFTER_MINUTES: Int = 33

/**
 * Places blocks, given as `start..end` minutes in the order they should be drawn, as the system Calendar does: blocks
 * that overlap and start within [CASCADE_AFTER_MINUTES] of each other stand side by side in columns; a block that
 * starts later than that over one it overlaps shares its column and is drawn over it, one [TimelineLane.depth] step
 * further in than the deepest block under it. [TimelineLane.columns] is the number of columns of the group a block
 * belongs to, so each group of overlapping blocks is divided evenly. Blocks that only touch do not overlap, and a
 * block shorter than [MIN_BLOCK_MINUTES] is laid out as if it were that long.
 */
fun layoutTimeline(blocks: List<IntRange>): List<TimelineLane> {
    val laidOut = blocks.map { it.first..maxOf(it.last, it.first + MIN_BLOCK_MINUTES) }
    val order = laidOut.indices.sortedWith(compareBy({ laidOut[it].first }, { -laidOut[it].last }))
    val columnOf = IntArray(blocks.size)
    val depthOf = IntArray(blocks.size)
    val groupOf = IntArray(blocks.size)
    val placed = mutableListOf<Int>()
    var groupEnd = Int.MIN_VALUE
    var group = -1
    for (index in order) {
        val block = laidOut[index]
        if (block.first >= groupEnd) {
            group += 1
            placed.clear()
        }
        val overlapped = placed.filter { laidOut[it].last > block.first }
        val beside = overlapped.filter { block.first - laidOut[it].first < CASCADE_AFTER_MINUTES }
        var column = 0
        while (beside.any { columnOf[it] == column }) column += 1
        columnOf[index] = column
        depthOf[index] = overlapped.filter { columnOf[it] == column }.maxOfOrNull { depthOf[it] + 1 } ?: 0
        groupOf[index] = group
        placed.add(index)
        groupEnd = if (block.first >= groupEnd) block.last else maxOf(groupEnd, block.last)
    }
    val widest = IntArray(group + 1)
    for (index in blocks.indices) widest[groupOf[index]] = maxOf(widest[groupOf[index]], columnOf[index] + 1)
    return blocks.indices.map { TimelineLane(columnOf[it], widest[groupOf[it]], depthOf[it]) }
}
