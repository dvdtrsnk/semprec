package cz.alldots.app.domain

/** One event of a day as the Journal lists it. [projectColor] is the `#RRGGBB` of its project, when it has one. */
data class JournalEvent(
    val id: String,
    val title: String,
    val timeFrom: ClockTime?,
    val timeTo: ClockTime?,
    val allDay: Boolean,
    val place: String?,
    val projectName: String?,
    val projectColor: String?,
    val hasTranscript: Boolean,
)

data class JournalBirthday(val id: String, val personName: String)

/**
 * One Inbox item captured on a day. [status] and [processing] are the backend's canonical keys; the app writes the
 * words for them. [attachments] are its files in the order the item lists them.
 */
data class JournalInboxEntry(
    val id: String,
    val time: String?,
    val text: String?,
    val typeEmoji: String?,
    val status: String?,
    val processing: String?,
    val attachments: List<InboxAttachment>,
)

/** A week's page inside a day or a month: [week] is its ISO number, [itemId] and [markdown] are `null` until written. */
data class JournalWeekPage(
    val period: String,
    val week: Int,
    val from: CalendarDay,
    val to: CalendarDay,
    val itemId: String?,
    val markdown: String?
)

/** A quarter's page inside a year: [quarter] is 1 to 4, [itemId] and [markdown] are `null` until written. */
data class JournalQuarterPage(
    val period: String,
    val quarter: Int,
    val from: CalendarDay,
    val to: CalendarDay,
    val itemId: String?,
    val markdown: String?
)

/** What the API answers for one period: its own page, and for a day, a month or a year the pieces the screen shows. */
data class JournalPeriodPage(
    val period: JournalPeriod,
    val from: CalendarDay,
    val to: CalendarDay,
    val today: CalendarDay,
    val itemId: String?,
    val markdown: String?,
    val weeks: List<JournalWeekPage>,
    val quarters: List<JournalQuarterPage>,
    val inbox: List<JournalInboxEntry>,
    val events: List<JournalEvent>,
    val birthdays: List<JournalBirthday>,
)

/** The Markdown of a page and the version token ([etag], quoted as the server sent it) a replacement must quote. */
data class PageDocument(val markdown: String, val etag: String)

/**
 * The answer to replacing a page (docs/adr/2026-11-23-note-edits-merge-three-ways-and-wait-on-the-device.md):
 * - [Saved]: the server holds the Markdown written, at the version [Saved.etag].
 * - [Merged]: the change was merged three ways with what changed elsewhere meanwhile, and the page holds
 *   [Merged.markdown] now, on the server or, until it can be reached, on the device; the next change is written
 *   against [Merged.etag].
 * - [Kept]: the device holds the Markdown written and sends it once the server can be reached.
 * - [Conflict]: the page changed meanwhile and the change could not be merged.
 */
sealed interface PageWrite {
    data class Saved(val etag: String) : PageWrite
    data class Merged(val etag: String, val markdown: String) : PageWrite
    data object Kept : PageWrite
    data object Conflict : PageWrite
}
