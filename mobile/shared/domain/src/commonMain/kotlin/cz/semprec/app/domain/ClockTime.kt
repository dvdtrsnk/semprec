package cz.semprec.app.domain

import kotlin.jvm.JvmInline

private const val MINUTES_IN_HOUR = 60
private const val MINUTES_IN_DAY = 24 * MINUTES_IN_HOUR
private const val TIME_SEPARATOR = ':'
private const val MINUTE_DIGITS = 2

/**
 * A wall-clock time of day in minutes, written `HH:MM` on the wire. `24:00` is the midnight that closes a day and
 * is only valid as an end ([isEndOfDay]); the server takes a start in `00:00` to `23:59`.
 */
@JvmInline
value class ClockTime(val minutes: Int) : Comparable<ClockTime> {
    init {
        require(minutes in 0..MINUTES_IN_DAY) { "Invalid clock time" }
    }

    val hour: Int get() = minutes / MINUTES_IN_HOUR
    val minute: Int get() = minutes % MINUTES_IN_HOUR
    val isEndOfDay: Boolean get() = minutes == MINUTES_IN_DAY

    override fun compareTo(other: ClockTime): Int = minutes.compareTo(other.minutes)

    /** `HH:MM`, the form the API stores. */
    override fun toString(): String = "${hour.toString().padStart(MINUTE_DIGITS, '0')}$TIME_SEPARATOR" +
        minute.toString().padStart(MINUTE_DIGITS, '0')

    companion object {
        const val DAY_MINUTES: Int = MINUTES_IN_DAY

        /** Reads `H:MM` or `HH:MM` (`24:00` included); anything else is `null`. */
        fun parse(text: String): ClockTime? {
            val parts = text.split(TIME_SEPARATOR)
            val hour = parts.getOrNull(0)?.takeIf { it.length in 1..MINUTE_DIGITS }?.toDigitsOrNull()
            val minute = parts.getOrNull(1)?.takeIf { it.length == MINUTE_DIGITS }?.toDigitsOrNull()
            val total = if (hour != null && minute != null) hour * MINUTES_IN_HOUR + minute else null
            val valid = parts.size == 2 && minute != null && minute < MINUTES_IN_HOUR && total != null &&
                total <= MINUTES_IN_DAY
            return if (valid && total != null) ClockTime(total) else null
        }

        private fun String.toDigitsOrNull(): Int? = if (isNotEmpty() && all { it in '0'..'9' }) toIntOrNull() else null
    }
}
