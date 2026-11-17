package cz.semprec.app.presentation

/** The kinds of period the Journal keeps a page for; the time axis shows every kind but [WEEK]. */
enum class JournalPeriodKind { YEAR, QUARTER, MONTH, WEEK, DAY }

/** Which page an edit is for: the period it belongs to, named by its canonical key (`2026-Q4`, `2026-W42`). */
data class JournalPageRef(val kind: JournalPeriodKind, val period: String)

enum class JournalBlockKind { TEXT, H1, H2, H3, BULLET, NUMBER, TODO, QUOTE, PAGE }

/** A stretch of text with one formatting; the screen builds styled text from it and never sees Markdown. */
data class JournalRun(
    val text: String,
    val bold: Boolean,
    val italic: Boolean,
    val code: Boolean,
    val link: String?,
)

/**
 * One block of a page. [index] is its place in the page, which an edit names. [ordinal] is the number of a
 * numbered item within its list (1 for the first), 0 for other blocks. For a [JournalBlockKind.PAGE] block the
 * caption is in [runs] and the subpage is [pageId].
 */
data class JournalBlock(
    val index: Int,
    val kind: JournalBlockKind,
    val indent: Int,
    val done: Boolean,
    val ordinal: Int,
    val runs: List<JournalRun>,
    val pageId: String?,
)

data class JournalPageState(val ref: JournalPageRef, val blocks: List<JournalBlock>)

/** A week of the diary. [from] and [to] are `YYYY-MM-DD`; [page] is its note. */
data class JournalWeekState(val number: Int, val from: String, val to: String, val page: JournalPageState)

/** An event of the selected day; the times are minutes since midnight and `null` for an all-day event. */
data class JournalEventState(
    val id: String,
    val title: String,
    val startMinutes: Int?,
    val endMinutes: Int?,
    val allDay: Boolean,
    val place: String?,
    val projectName: String?,
    val projectColor: String?,
    val hasTranscript: Boolean,
)

data class JournalBirthdayState(val id: String, val personName: String)

/** Where an Inbox item stands, from the backend's canonical keys. */
enum class JournalInboxStatus { NONE, PENDING, FAILED, NEEDS_CLARIFICATION, PROPOSED, CONFIRMED, REJECTED, INVALID }

data class JournalInboxState(
    val id: String,
    val time: String?,
    val text: String?,
    val emoji: String?,
    val status: JournalInboxStatus,
    val attachmentName: String?,
    val attachmentCount: Int,
)

/** One cell of a row of the time axis; [start] is the first day of its period, `YYYY-MM-DD`. */
data class JournalAxisCellState(
    val kind: JournalPeriodKind,
    val start: String,
    val year: Int,
    val quarter: Int,
    val month: Int,
    val day: Int,
    val weekday: Int,
    val onPath: Boolean,
    val current: Boolean,
    val today: Boolean,
)

data class JournalAxisRowState(val kind: JournalPeriodKind, val cells: List<JournalAxisCellState>)

/** Why the last change to a page did not go through. */
enum class JournalEditProblem {
    /** The page changed on the server since it was read; reloading shows what is there now. */
    STALE,

    /** The write failed; [JournalState.editFailure] says how when the reason is an expected one. */
    FAILED,
}
