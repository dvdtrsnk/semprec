package cz.semprec.app.domain

/**
 * A page of the agenda: the stored events and tasks from a day on, and the cursor of the next page, `null` at its
 * end.
 */
data class CalendarAgendaPage(val entries: List<CalendarEntry>, val nextCursor: String?)

/** The agenda of the calendar: what is stored from a day on, in time order, a page at a time. */
interface CalendarAgendaRepository {
    /** The page that starts at [cursor], or at [from] when [cursor] is `null`. */
    suspend fun page(from: CalendarDay, cursor: String?): RepositoryResult<CalendarAgendaPage>
}

/**
 * The agenda's entries by day, the days in the order the pages bring them: on each day the entries without a time
 * first, then by their start.
 */
fun List<CalendarEntry>.agendaDays(): List<Pair<CalendarDay, List<CalendarEntry>>> {
    val byTime = compareBy<CalendarEntry> { it.timeFrom != null }.thenBy { it.timeFrom?.minutes }
    return groupBy { it.date }.map { (day, entries) -> day to entries.sortedWith(byTime) }
}
