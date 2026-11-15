package cz.semprec.app.domain

private const val YEARS_AROUND = 6
private const val QUARTER_YEARS_AROUND = 3
private const val MONTH_YEARS_AROUND = 2
private const val DAY_MONTHS_AROUND = 3
private const val MONTHS_IN_YEAR = 12
private const val MONTHS_IN_QUARTER = 3

/** The levels the time axis shows, from the widest to the narrowest; weeks live inside a month and a day. */
val JOURNAL_AXIS_LEVELS: List<JournalPeriodType> =
    listOf(JournalPeriodType.YEAR, JournalPeriodType.QUARTER, JournalPeriodType.MONTH, JournalPeriodType.DAY)

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
 * The four rows of the axis around [selectedStart]. Each row is a window large enough to scroll through without
 * the selection moving, and the windows move with the selection, so a pick on any cell recenters the axis.
 */
fun journalAxis(selectedType: JournalPeriodType, selectedStart: CalendarDay, today: CalendarDay): List<JournalAxisRow> {
    val depth = JOURNAL_AXIS_LEVELS.indexOf(selectedType)
    return JOURNAL_AXIS_LEVELS.mapIndexed { level, type ->
        val cells = windowStarts(type, selectedStart).map { start ->
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

private fun windowStarts(type: JournalPeriodType, anchor: CalendarDay): List<CalendarDay> = when (type) {
    JournalPeriodType.YEAR -> (-YEARS_AROUND..YEARS_AROUND).map { CalendarDay(anchor.year + it, 1, 1) }
    JournalPeriodType.QUARTER -> monthStarts(anchor.year - QUARTER_YEARS_AROUND, anchor.year + QUARTER_YEARS_AROUND)
        .filter { (it.month - 1) % MONTHS_IN_QUARTER == 0 }
    JournalPeriodType.MONTH -> monthStarts(anchor.year - MONTH_YEARS_AROUND, anchor.year + MONTH_YEARS_AROUND)
    JournalPeriodType.DAY -> {
        val first = anchor.startOfMonth().plusMonths(-DAY_MONTHS_AROUND)
        val last = anchor.startOfMonth().plusMonths(DAY_MONTHS_AROUND).let { it.plusDays(it.lengthOfMonth() - 1) }
        (0..(last.epochDay - first.epochDay).toInt()).map { first.plusDays(it) }
    }
    JournalPeriodType.WEEK -> emptyList()
}

private fun monthStarts(fromYear: Int, toYear: Int): List<CalendarDay> =
    (fromYear..toYear).flatMap { year -> (1..MONTHS_IN_YEAR).map { CalendarDay(year, it, 1) } }
