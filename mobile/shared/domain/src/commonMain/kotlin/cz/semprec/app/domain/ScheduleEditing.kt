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
    fun duration(schedule: Schedule): Int? {
        val from = schedule.timeFrom
        val to = schedule.timeTo
        return if (from == null || to == null) null else to.minutes - from.minutes
    }

    /**
     * The end a timed item is drawn to: its end, or a short block after its start. Never later than midnight.
     */
    fun visibleEnd(schedule: Schedule): Int? {
        val from = schedule.timeFrom ?: return null
        val to = schedule.timeTo?.minutes ?: (from.minutes + SHORT_BLOCK_MINUTES)
        return minOf(to, DAY_MINUTES)
    }

    /**
     * Moves a single-day item so that it starts at [rawStart] (snapped). A timed item keeps its duration, so the
     * start is kept low enough for the end to stay inside the day; an all-day item becomes timed.
     */
    fun moveTo(kind: CalendarEntryKind, schedule: Schedule, day: CalendarDay, rawStart: Int): Schedule {
        val length = if (schedule.allDay) defaultLength(kind) else duration(schedule)
        val visible = length ?: SHORT_BLOCK_MINUTES
        val start = snap(rawStart).coerceAtMost(DAY_MINUTES - visible)
        val end = length?.let { start + it }
        return Schedule(day, null, ClockTime(start), end?.let { ClockTime(it) })
    }

    /** Pulls an item into the all-day row: the times go, a multi-day span stays. */
    fun toAllDay(schedule: Schedule, day: CalendarDay): Schedule =
        Schedule(day, schedule.endDate?.takeIf { it > day }, null, null)

    /** Moves an item to [day] and keeps its time of day; a multi-day event keeps its length in days. */
    fun toDay(schedule: Schedule, day: CalendarDay): Schedule {
        val shift = (day.epochDay - schedule.date.epochDay).toInt()
        return schedule.copy(date = day, endDate = schedule.endDate?.plusDays(shift))
    }

    /**
     * Drags the start edge to [rawStart]. The start stays at least one step before the end; an item with no end
     * keeps the end of its short block as its end, so the edge has something to stay in front of.
     */
    fun resizeStart(schedule: Schedule, rawStart: Int): Schedule {
        val end = visibleEnd(schedule) ?: return schedule
        val start = snap(rawStart).coerceIn(0, end - STEP_MINUTES)
        return schedule.copy(timeFrom = ClockTime(start), timeTo = ClockTime(end))
    }

    /** Drags the end edge to [rawEnd]; the end stays at least one step after the start and inside the day. */
    fun resizeEnd(schedule: Schedule, rawEnd: Int): Schedule {
        val start = schedule.timeFrom ?: return schedule
        val end = snap(rawEnd).coerceIn(start.minutes + STEP_MINUTES, DAY_MINUTES)
        return schedule.copy(timeTo = ClockTime(end))
    }

    private fun defaultLength(kind: CalendarEntryKind): Int? =
        if (kind == CalendarEntryKind.EVENT) DEFAULT_EVENT_MINUTES else null
}

/** One block of a day's timeline laid out next to the blocks it overlaps. */
data class TimelineLane(val column: Int, val columns: Int)

/**
 * Places blocks, given as `start..end` minutes in the order they should be drawn, in as few columns as keep every
 * block clear of the ones it overlaps; [TimelineLane.columns] is the number of columns of the group a block
 * belongs to, so each group of overlapping blocks is divided evenly. Blocks that only touch do not overlap.
 */
fun layoutTimeline(blocks: List<IntRange>): List<TimelineLane> {
    val columnOf = IntArray(blocks.size)
    val groupOf = IntArray(blocks.size)
    var groupEnd = Int.MIN_VALUE
    var group = -1
    val columnEnds = mutableListOf<Int>()
    val order = blocks.indices.sortedWith(compareBy({ blocks[it].first }, { blocks[it].last }))
    for (index in order) {
        val block = blocks[index]
        if (block.first >= groupEnd) {
            group += 1
            columnEnds.clear()
        }
        val free = columnEnds.indexOfFirst { it <= block.first }
        val column = if (free >= 0) free else columnEnds.size
        if (column == columnEnds.size) columnEnds.add(block.last) else columnEnds[column] = block.last
        columnOf[index] = column
        groupOf[index] = group
        groupEnd = if (block.first >= groupEnd) block.last else maxOf(groupEnd, block.last)
    }
    val widest = IntArray(group + 1)
    for (index in blocks.indices) widest[groupOf[index]] = maxOf(widest[groupOf[index]], columnOf[index] + 1)
    return blocks.indices.map { TimelineLane(columnOf[it], widest[groupOf[it]]) }
}
