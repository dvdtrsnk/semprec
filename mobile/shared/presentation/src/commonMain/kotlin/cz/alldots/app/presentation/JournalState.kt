package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class JournalPhase { LOADING, CONTENT, ERROR }

/**
 * The selected period: its kind (never [JournalPeriodKind.QUARTER] or [JournalPeriodKind.WEEK]) and its first day,
 * `YYYY-MM-DD`.
 */
data class JournalSelection(val kind: JournalPeriodKind, val start: String)

/**
 * The diary screen. [axis] is the time axis around the selection; [page] is the note of a day or a year (a month
 * has none: it lists its [weeks]); a year lists its [quarters]; a day has its own week in [weeks] and its [events],
 * [birthdays] and [inbox]. [today] is the server's current day. [shown] is the period those belong to: right after a new selection it
 * is still the previous one, until the new period arrives, so the screen lays the content out as what it is.
 * [before] and [after] are the periods of the same kind beside [shown], once they have been read: the screen can lay
 * them out beside the shown one before the person turns to them.
 */
data class JournalState(
    val phase: JournalPhase,
    val selection: JournalSelection,
    val today: String,
    val axis: List<JournalAxisRowState>,
    val failure: FailureKind? = null,
    val page: JournalPageState? = null,
    val weeks: List<JournalWeekState> = emptyList(),
    val quarters: List<JournalQuarterState> = emptyList(),
    val events: List<JournalEventState> = emptyList(),
    val birthdays: List<JournalBirthdayState> = emptyList(),
    val inbox: List<JournalInboxState> = emptyList(),
    val shown: JournalSelection? = null,
    val before: JournalPeriodContent? = null,
    val after: JournalPeriodContent? = null,
)

/** What the diary shows for one period ([shown]), as [JournalState] lists it for the shown period. */
data class JournalPeriodContent(
    val shown: JournalSelection,
    val page: JournalPageState?,
    val weeks: List<JournalWeekState>,
    val quarters: List<JournalQuarterState>,
    val events: List<JournalEventState>,
    val birthdays: List<JournalBirthdayState>,
    val inbox: List<JournalInboxState>,
)
