package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class CalendarAgendaKind { EVENT, TASK }

/**
 * One stored event or task of the agenda. [timeFrom] and [timeTo] are `HH:mm`, both `null` for an all-day entry;
 * [done] is a finished task.
 */
data class CalendarAgendaEntry(
    val id: String,
    val kind: CalendarAgendaKind,
    val title: String,
    val timeFrom: String?,
    val timeTo: String?,
    val allDay: Boolean,
    val done: Boolean,
    val place: String?,
)

/** The entries of one day, `YYYY-MM-DD`, in time order. */
data class CalendarAgendaDay(val day: String, val entries: List<CalendarAgendaEntry>)

enum class CalendarAgendaPhase { LOADING, CONTENT, ERROR }

/**
 * The agenda: what is stored from a day on, by day. [hasMore] while the server has a further page; [loadingMore]
 * while it is read; [moreFailure] says why the last further page was not read, the days already shown stay.
 */
data class CalendarAgendaState(
    val phase: CalendarAgendaPhase = CalendarAgendaPhase.LOADING,
    val failure: FailureKind? = null,
    val days: List<CalendarAgendaDay> = emptyList(),
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val moreFailure: Failed? = null,
)

sealed interface CalendarAgendaAction {
    /** Reads the agenda again from its first day. */
    data object Retry : CalendarAgendaAction

    /** Reads the next page, unless there is none or one is being read. */
    data object LoadMore : CalendarAgendaAction

    /** Opens the entry [id] of the agenda in Podrobnosti. */
    data class Open(val id: String) : CalendarAgendaAction
}

sealed interface CalendarAgendaEffect {
    data class OpenDetails(val kind: CalendarAgendaKind, val id: String) : CalendarAgendaEffect
}
