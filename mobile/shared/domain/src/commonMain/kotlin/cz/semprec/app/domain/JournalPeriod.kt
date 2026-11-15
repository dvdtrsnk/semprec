package cz.semprec.app.domain

private const val MONTHS_IN_QUARTER = 3
private const val DAYS_IN_WEEK = 7
private const val ISO_WEEK_ANCHOR_DAY = 4
private const val PAD_YEAR = 4
private const val PAD_PART = 2

/** A kind of period the Journal keeps one page for; [wireName] is what the API puts in a path. */
enum class JournalPeriodType(val wireName: String) {
    YEAR("year"),
    QUARTER("quarter"),
    MONTH("month"),
    WEEK("week"),
    DAY("day"),
}

/**
 * One Journal period: its [type] and the canonical [key] the API names it by (`2026`, `2026-Q4`, `2026-10`,
 * `2026-W42`, `2026-10-16`). Keys are computed here, never parsed from free text, so they always spell what the
 * server stores.
 */
data class JournalPeriod(val type: JournalPeriodType, val key: String) {
    companion object {
        /** The period of [type] that contains [day]. */
        fun containing(type: JournalPeriodType, day: CalendarDay): JournalPeriod = JournalPeriod(type, keyOf(type, day))

        private fun keyOf(type: JournalPeriodType, day: CalendarDay): String = when (type) {
            JournalPeriodType.YEAR -> pad(day.year, PAD_YEAR)
            JournalPeriodType.QUARTER -> "${pad(day.year, PAD_YEAR)}-Q${day.quarter()}"
            JournalPeriodType.MONTH -> "${pad(day.year, PAD_YEAR)}-${pad(day.month, PAD_PART)}"
            JournalPeriodType.WEEK -> day.isoWeek().let { "${pad(it.weekYear, PAD_YEAR)}-W${pad(it.week, PAD_PART)}" }
            JournalPeriodType.DAY -> day.toString()
        }

        private fun pad(value: Int, width: Int): String = value.toString().padStart(width, '0')
    }
}

/** The ISO 8601 week a day belongs to; [weekYear] differs from the calendar year around New Year. */
data class IsoWeek(val weekYear: Int, val week: Int)

/** The quarter of the year, 1 to 4. */
fun CalendarDay.quarter(): Int = (month - 1) / MONTHS_IN_QUARTER + 1

/** The ISO week of this day: the week of its Thursday, numbered from the week that holds 4 January. */
fun CalendarDay.isoWeek(): IsoWeek {
    val thursday = plusDays(ISO_WEEK_ANCHOR_DAY - isoDayOfWeek)
    val firstDay = CalendarDay(thursday.year, 1, 1)
    val week = ((thursday.epochDay - firstDay.epochDay) / DAYS_IN_WEEK).toInt() + 1
    return IsoWeek(thursday.year, week)
}

/** The first day of the period of [type] this day is in (a week starts on Monday). */
fun CalendarDay.startOf(type: JournalPeriodType): CalendarDay = when (type) {
    JournalPeriodType.YEAR -> CalendarDay(year, 1, 1)
    JournalPeriodType.QUARTER -> CalendarDay(year, (quarter() - 1) * MONTHS_IN_QUARTER + 1, 1)
    JournalPeriodType.MONTH -> startOfMonth()
    JournalPeriodType.WEEK -> startOfWeek()
    JournalPeriodType.DAY -> this
}

/** The last day of the period of [type] this day is in. */
fun CalendarDay.endOf(type: JournalPeriodType): CalendarDay = when (type) {
    JournalPeriodType.YEAR -> CalendarDay(year, MONTHS_IN_YEAR, CalendarDay.daysIn(year, MONTHS_IN_YEAR))
    JournalPeriodType.QUARTER -> startOf(type).plusMonths(MONTHS_IN_QUARTER).plusDays(-1)
    JournalPeriodType.MONTH -> CalendarDay(year, month, lengthOfMonth())
    JournalPeriodType.WEEK -> startOfWeek().plusDays(DAYS_IN_WEEK - 1)
    JournalPeriodType.DAY -> this
}

private const val MONTHS_IN_YEAR = 12
