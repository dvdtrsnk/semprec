package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class JournalPhase { LOADING, CONTENT, ERROR }

/** The selected period: its kind (never [JournalPeriodKind.WEEK]) and its first day, `YYYY-MM-DD`. */
data class JournalSelection(val kind: JournalPeriodKind, val start: String)

/**
 * The diary screen. [axis] is the time axis around the selection; [page] is the note of a day, quarter or year (a
 * month has none: it lists its [weeks]); a day has its own week in [weeks] and its [events], [birthdays] and
 * [inbox]. [today] is the server's current day. [saving] is `true` while a change is written; [editProblem] says why
 * the last one was not.
 */
data class JournalState(
    val phase: JournalPhase,
    val selection: JournalSelection,
    val today: String,
    val axis: List<JournalAxisRowState>,
    val failure: FailureKind? = null,
    val page: JournalPageState? = null,
    val weeks: List<JournalWeekState> = emptyList(),
    val events: List<JournalEventState> = emptyList(),
    val birthdays: List<JournalBirthdayState> = emptyList(),
    val inbox: List<JournalInboxState> = emptyList(),
    val saving: Boolean = false,
    val editProblem: JournalEditProblem? = null,
    val editFailure: FailureKind? = null,
)

/** A subpage of the diary opened on its own. */
data class JournalSubpageState(
    val phase: JournalPhase = JournalPhase.LOADING,
    val failure: FailureKind? = null,
    val blocks: List<JournalBlock> = emptyList(),
    val saving: Boolean = false,
    val editProblem: JournalEditProblem? = null,
    val editFailure: FailureKind? = null,
)
