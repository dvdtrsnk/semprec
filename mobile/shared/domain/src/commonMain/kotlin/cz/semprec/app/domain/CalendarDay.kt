package cz.semprec.app.domain

private const val MONTHS_IN_YEAR = 12
private const val DAYS_IN_WEEK = 7
private const val DAYS_IN_YEAR = 365
private const val DAYS_IN_LEAP_YEAR = 366
private const val LEAP_CYCLE = 4
private const val CENTURY = 100
private const val GREGORIAN_CYCLE = 400
private const val EPOCH_YEAR = 1970
private const val FEBRUARY = 2
private const val FEBRUARY_LEAP_DAYS = 29
private const val YEAR_DIGITS = 4
private const val PART_DIGITS = 2
private const val DATE_LENGTH = 10
private const val PARTS_OF_DATE = 3
private const val FIRST_SEPARATOR = 4
private const val SECOND_SEPARATOR = 7

private val MONTH_LENGTHS = listOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

private fun isLeapYear(year: Int): Boolean =
    year % LEAP_CYCLE == 0 && (year % CENTURY != 0 || year % GREGORIAN_CYCLE == 0)

private fun daysInYear(year: Int): Int = if (isLeapYear(year)) DAYS_IN_LEAP_YEAR else DAYS_IN_YEAR

/** The days of the proleptic Gregorian years before [year] (year 1 is the first), the base of the day count. */
private fun daysBeforeYear(year: Int): Long {
    val previous = (year - 1).toLong()
    return DAYS_IN_YEAR * previous + previous / LEAP_CYCLE - previous / CENTURY + previous / GREGORIAN_CYCLE
}

/**
 * A calendar date without a zone, written `YYYY-MM-DD` on the wire. The server decides which day "today" is (in
 * the tenant's zone); this type only does the arithmetic of the proleptic Gregorian calendar, so no screen needs a
 * platform date API for it.
 */
data class CalendarDay(val year: Int, val month: Int, val day: Int) : Comparable<CalendarDay> {
    init {
        require(year >= 1 && month in 1..MONTHS_IN_YEAR && day in 1..daysIn(year, month)) { "Invalid calendar day" }
    }

    /** Days since 1970-01-01, negative before it. */
    val epochDay: Long
        get() {
            val dayOfYear = (1 until month).sumOf { daysIn(year, it) } + day
            return daysBeforeYear(year) + dayOfYear - 1 - EPOCH_BASE
        }

    /** 1 for Monday up to 7 for Sunday, the ISO numbering the week views use. */
    val isoDayOfWeek: Int get() = (epochDay + 3).mod(DAYS_IN_WEEK) + 1

    fun plusDays(days: Int): CalendarDay = ofEpochDay(epochDay + days)

    /** The same day of the month in the month [months] away, or its last day when that month is shorter. */
    fun plusMonths(months: Int): CalendarDay {
        val total = year * MONTHS_IN_YEAR + (month - 1) + months
        val newYear = total.floorDiv(MONTHS_IN_YEAR)
        val newMonth = total.mod(MONTHS_IN_YEAR) + 1
        return CalendarDay(newYear, newMonth, minOf(day, daysIn(newYear, newMonth)))
    }

    /** The Monday of the ISO week this day is in. */
    fun startOfWeek(): CalendarDay = plusDays(1 - isoDayOfWeek)

    fun startOfMonth(): CalendarDay = CalendarDay(year, month, 1)

    fun lengthOfMonth(): Int = daysIn(year, month)

    override fun compareTo(other: CalendarDay): Int = epochDay.compareTo(other.epochDay)

    override fun toString(): String = "${pad(year, YEAR_DIGITS)}-${pad(month, PART_DIGITS)}-${pad(day, PART_DIGITS)}"

    companion object {
        private val EPOCH_BASE = daysBeforeYear(EPOCH_YEAR)

        /** Reads `YYYY-MM-DD`; anything else, including an impossible date, is `null`. */
        fun parse(text: String): CalendarDay? {
            val shaped = text.length == DATE_LENGTH && text[FIRST_SEPARATOR] == '-' && text[SECOND_SEPARATOR] == '-'
            val parts = if (shaped) text.split('-').map { it.toDigitsOrNull() } else emptyList()
            val (year, month, day) = if (parts.size == PARTS_OF_DATE) parts else listOf(null, null, null)
            return if (year != null && month != null && day != null) ofOrNull(year, month, day) else null
        }

        private fun ofOrNull(year: Int, month: Int, day: Int): CalendarDay? =
            if (year >= 1 && month in 1..MONTHS_IN_YEAR && day in 1..daysIn(year, month)) {
                CalendarDay(year, month, day)
            } else {
                null
            }

        private fun String.toDigitsOrNull(): Int? = if (all { it in '0'..'9' }) toIntOrNull() else null

        fun ofEpochDay(epochDay: Long): CalendarDay {
            var year = EPOCH_YEAR + epochDay.floorDiv(DAYS_IN_LEAP_YEAR).toInt()
            var remaining = epochDay + EPOCH_BASE - daysBeforeYear(year)
            while (remaining < 0) {
                year -= 1
                remaining += daysInYear(year)
            }
            while (remaining >= daysInYear(year)) {
                remaining -= daysInYear(year)
                year += 1
            }
            var month = 1
            while (remaining >= daysIn(year, month)) {
                remaining -= daysIn(year, month)
                month += 1
            }
            return CalendarDay(year, month, remaining.toInt() + 1)
        }

        fun daysIn(year: Int, month: Int): Int =
            if (month == FEBRUARY && isLeapYear(year)) FEBRUARY_LEAP_DAYS else MONTH_LENGTHS[month - 1]

        private fun pad(value: Int, width: Int): String = value.toString().padStart(width, '0')
    }
}
