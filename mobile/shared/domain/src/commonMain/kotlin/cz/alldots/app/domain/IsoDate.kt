package cz.alldots.app.domain

/**
 * A calendar day (`2026-10-16`), counted in days since 1970-01-01, with the date arithmetic the screens need. It has
 * no clock: today is always handed in by the native app.
 */
class IsoDate private constructor(val epochDay: Int) : Comparable<IsoDate> {
    private val civil: Triple<Int, Int, Int> by lazy(LazyThreadSafetyMode.NONE) { civilOf(epochDay) }

    val year: Int get() = civil.first
    val month: Int get() = civil.second
    val day: Int get() = civil.third

    /** Monday is 1, Sunday is 7. */
    val dayOfWeek: Int get() = (epochDay + EPOCH_WEEKDAY - 1).mod(DAYS_IN_WEEK) + 1

    fun plusDays(days: Int): IsoDate = IsoDate(epochDay + days)

    /** The number of days from this day to [other]: positive when [other] is later. */
    fun daysUntil(other: IsoDate): Int = other.epochDay - epochDay

    override fun compareTo(other: IsoDate): Int = epochDay.compareTo(other.epochDay)

    override fun equals(other: Any?): Boolean = other is IsoDate && other.epochDay == epochDay

    override fun hashCode(): Int = epochDay

    override fun toString(): String {
        val years = year.toString().padStart(YEAR_DIGITS, '0')
        return "$years-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"
    }

    companion object {
        private const val EPOCH_YEAR = 1970
        private const val EPOCH_WEEKDAY = 4
        private const val DAYS_IN_WEEK = 7
        private const val YEAR_DIGITS = 4
        private const val LAST_MONTH = 12
        private const val LEAP_CYCLE = 4
        private const val CENTURY = 100
        private const val LEAP_ERA = 400
        private const val DAYS_IN_FEBRUARY = 28
        private val MONTH_LENGTHS = intArrayOf(31, DAYS_IN_FEBRUARY, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
        private val PATTERN = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")

        /** The day `yyyy-MM-dd` names, or `null` for text that is no real calendar day. */
        fun parse(text: String): IsoDate? {
            val match = PATTERN.matchEntire(text) ?: return null
            val (year, month, day) = match.destructured.toList().map { it.toInt() }
            return of(year, month, day)
        }

        fun of(year: Int, month: Int, day: Int): IsoDate? {
            val real = month in 1..LAST_MONTH && day in 1..daysIn(year, month)
            return if (real) IsoDate(epochDayOf(year, month, day)) else null
        }

        private fun isLeap(year: Int): Boolean =
            year % LEAP_CYCLE == 0 && (year % CENTURY != 0 || year % LEAP_ERA == 0)

        private fun daysIn(year: Int, month: Int): Int =
            MONTH_LENGTHS[month - 1] + if (month == 2 && isLeap(year)) 1 else 0

        private fun daysInYear(year: Int): Int = (1..LAST_MONTH).sumOf { daysIn(year, it) }

        private fun epochDayOf(year: Int, month: Int, day: Int): Int {
            val wholeYears = if (year >= EPOCH_YEAR) {
                (EPOCH_YEAR until year).sumOf(::daysInYear)
            } else {
                -(year until EPOCH_YEAR).sumOf(::daysInYear)
            }
            return wholeYears + (1 until month).sumOf { daysIn(year, it) } + day - 1
        }

        private fun civilOf(epochDay: Int): Triple<Int, Int, Int> {
            var year = EPOCH_YEAR
            var left = epochDay
            while (left < 0) {
                year -= 1
                left += daysInYear(year)
            }
            while (left >= daysInYear(year)) {
                left -= daysInYear(year)
                year += 1
            }
            var month = 1
            while (left >= daysIn(year, month)) {
                left -= daysIn(year, month)
                month += 1
            }
            return Triple(year, month, left + 1)
        }
    }
}
