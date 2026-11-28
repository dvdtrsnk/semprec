package cz.alldots.app.domain

/** Every row spans the same calendar years: this many before and after the year of the window's anchor. */
private const val YEARS_AROUND = 2
private const val MONTHS_IN_YEAR = 12

/**
 * The levels the time axis shows, from the widest to the narrowest; quarters live inside a year, weeks inside a month
 * and a day.
 */
val JOURNAL_AXIS_LEVELS: List<JournalPeriodType> =
    listOf(JournalPeriodType.YEAR, JournalPeriodType.MONTH, JournalPeriodType.DAY)

/**
 * One cell of the time axis: the period of [type] that starts on [start]. [onPath] is `true` for the period at
 * this level that contains the selection and for no level narrower than the selection; [current] marks the cell
 * of the selected level itself; [today] marks the period that contains today.
 */
data class JournalAxisCell(
    val type: JournalPeriodType,
    val start: CalendarDay,
    val onPath: Boolean,
    val current: Boolean,
    val today: Boolean,
)

data class JournalAxisRow(val type: JournalPeriodType, val cells: List<JournalAxisCell>)

/**
 * The three rows of the axis around [selectedStart]. The rows move together on screen, so every row spans the same
 * whole years: the two before the year of [around], that year and the two after it. Every period a row shows thus has
 * its days in the row of days, and a scroll to any of them never runs past the end of another row. The windows lie
 * around [around], the selection unless the person moved the axis away from it.
 */
fun journalAxis(
    selectedType: JournalPeriodType,
    selectedStart: CalendarDay,
    today: CalendarDay,
    around: CalendarDay = selectedStart,
): List<JournalAxisRow> {
    val depth = JOURNAL_AXIS_LEVELS.indexOf(selectedType)
    return JOURNAL_AXIS_LEVELS.mapIndexed { level, type ->
        val cells = windowStarts(type, around).map { start ->
            val onPath = level <= depth && start.startOf(type) == selectedStart.startOf(type)
            JournalAxisCell(
                type = type,
                start = start,
                onPath = onPath,
                current = onPath && level == depth,
                today = start.startOf(type) == today.startOf(type),
            )
        }
        JournalAxisRow(type, cells)
    }
}

/** Whether [day] lies in the years the axis spans around [around]. */
fun journalAxisWindowContains(around: CalendarDay, day: CalendarDay): Boolean =
    day.year in around.year - YEARS_AROUND..around.year + YEARS_AROUND

private fun windowStarts(type: JournalPeriodType, anchor: CalendarDay): List<CalendarDay> = when (type) {
    JournalPeriodType.YEAR -> (-YEARS_AROUND..YEARS_AROUND).map { CalendarDay(anchor.year + it, 1, 1) }
    JournalPeriodType.MONTH -> monthStarts(anchor.year - YEARS_AROUND, anchor.year + YEARS_AROUND)
    JournalPeriodType.DAY -> {
        val first = CalendarDay(anchor.year - YEARS_AROUND, 1, 1)
        val next = CalendarDay(anchor.year + YEARS_AROUND + 1, 1, 1)
        (0 until (next.epochDay - first.epochDay).toInt()).map { first.plusDays(it) }
    }
    JournalPeriodType.QUARTER, JournalPeriodType.WEEK -> emptyList()
}

private fun monthStarts(fromYear: Int, toYear: Int): List<CalendarDay> =
    (fromYear..toYear).flatMap { year -> (1..MONTHS_IN_YEAR).map { CalendarDay(year, it, 1) } }
