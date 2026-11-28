package cz.alldots.app.domain

/**
 * The rules of the Podrobnosti sheet for when a task or an event happens (Principles, "Čas a termíny"): no date means
 * no time, no start time means all day, no end means a short item at its start, the length follows from start and end,
 * a new start moves the end by the same length, and an end is never before its start.
 */
object ScheduleRules {
    private const val MINUTES_PER_HOUR = 60
    private const val LAST_MINUTE = 23 * MINUTES_PER_HOUR + 55
    private const val MINIMUM_LENGTH = 5
    private const val DEFAULT_LENGTH = 30
    private const val DEFAULT_START = 9 * MINUTES_PER_HOUR
    private const val EVENT_DEFAULT_LENGTH = 60
    private val TIME = Regex("""^(\d{1,2}):(\d{2})$""")

    /** Minutes since midnight of `H:mm` or `HH:mm`, or `null` for anything else. */
    fun minutes(time: String?): Int? = TIME.matchEntire(time.orEmpty())?.destructured?.let { (hours, minutes) ->
        hours.toInt() * MINUTES_PER_HOUR + minutes.toInt()
    }

    /** `HH:mm` of [minutes], kept inside the day (the last pickable minute is 23:55). */
    fun time(minutes: Int): String {
        val clamped = minutes.coerceIn(0, LAST_MINUTE)
        val hours = (clamped / MINUTES_PER_HOUR).toString().padStart(2, '0')
        return "$hours:${(clamped % MINUTES_PER_HOUR).toString().padStart(2, '0')}"
    }

    /** How long the item lasts, or `null` without both a start and an end. */
    fun lengthMinutes(schedule: Schedule): Int? {
        val from = minutes(schedule.timeFrom)
        val to = minutes(schedule.timeTo)
        return if (from == null || to == null) null else to - from
    }

    /**
     * A new [date]. `null` removes the date and with it every time (a task only; an event keeps its day). A new
     * start day leaves an earlier end day behind it, so the end day goes.
     */
    fun withDate(schedule: Schedule, date: String?): Schedule {
        if (date == null) return Schedule(null, null, null)
        val endDate = schedule.endDate?.takeIf { it >= date }
        return schedule.copy(date = date, endDate = endDate)
    }

    /** A new start time; `null` removes the start and the end, which makes the item last all day. */
    fun withTimeFrom(schedule: Schedule, from: String?): Schedule {
        val start = minutes(from) ?: return schedule.copy(timeFrom = null, timeTo = null)
        val length = lengthMinutes(schedule)
        return schedule.copy(timeFrom = time(start), timeTo = length?.let { time(start + it) })
    }

    /** A new end time, never before the start plus five minutes; `null` removes it. Without a start nothing changes. */
    fun withTimeTo(schedule: Schedule, to: String?): Schedule {
        val start = minutes(schedule.timeFrom)
        val end = minutes(to)
        return when {
            start == null -> schedule
            end == null -> schedule.copy(timeTo = null)
            else -> schedule.copy(timeTo = time(maxOf(start + MINIMUM_LENGTH, end)))
        }
    }

    /** The end the end switch turns on: half an hour after the start. Without a start nothing changes. */
    fun withDefaultEnd(schedule: Schedule): Schedule {
        val start = minutes(schedule.timeFrom) ?: return schedule
        return schedule.copy(timeTo = time(start + DEFAULT_LENGTH))
    }

    /** The start the time switch turns on: 9:00. */
    fun withDefaultStart(schedule: Schedule): Schedule =
        if (schedule.date == null) schedule else schedule.copy(timeFrom = time(DEFAULT_START), timeTo = null)

    /** An event runs all day, or from 9:00 for an hour. */
    fun withAllDay(schedule: Schedule, allDay: Boolean): Schedule =
        if (allDay) {
            schedule.copy(timeFrom = null, timeTo = null)
        } else {
            schedule.copy(timeFrom = time(DEFAULT_START), timeTo = time(DEFAULT_START + EVENT_DEFAULT_LENGTH))
        }
}
