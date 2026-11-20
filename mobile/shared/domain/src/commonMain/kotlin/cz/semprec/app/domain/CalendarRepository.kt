package cz.semprec.app.domain

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * A counter every write of the calendar data raises, so a screen that shows data another screen changes (the
 * calendars sheet hides a calendar, an invitation is accepted) reloads without the two knowing each other.
 */
class CalendarChanges {
    private val mutableRevision = MutableStateFlow(0)
    val revision: StateFlow<Int> = mutableRevision.asStateFlow()

    fun changed() {
        mutableRevision.update { it + 1 }
    }
}

/**
 * A calendar of the tenant: the container of events, or one Semprec fills itself (tasks, birthdays, sleep). [version]
 * is the token an edit sends as `ifVersion`.
 *
 * A calendar of an internet account ([CalendarKind.ACCOUNT]) belongs to [accountId] and carries the name and colour
 * the provider gives it ([remoteName], [remoteColor]). [name] and [color] are what the person set here, or the
 * provider's when nothing was set; [usesRemoteColor] says the colour is the provider's. A [readOnly] calendar takes no
 * new events.
 */
data class CalendarInfo(
    val id: String,
    val name: String,
    val color: String,
    val notify: Boolean,
    val hidden: Boolean,
    val isDefault: Boolean,
    val kind: CalendarKind,
    val systemKey: String?,
    val version: String,
    val accountId: String? = null,
    val readOnly: Boolean = false,
    val remoteName: String? = null,
    val remoteColor: String? = null,
    val usesRemoteColor: Boolean = false,
) {
    /** Whether a new event can be put on it: an own calendar, or a writable one of an internet account. */
    val takesNewEvents: Boolean
        get() = kind == CalendarKind.OWN || (kind == CalendarKind.ACCOUNT && !readOnly)
}

/**
 * Where a calendar comes from: made by the person, filled by Semprec, a subscription to a feed, or synced from an
 * internet account.
 */
enum class CalendarKind { OWN, SYSTEM, SUBSCRIPTION, ACCOUNT }

/** What deleting a calendar cancels: its events, the people who were invited and the cancellations sent. */
data class CalendarCancellationImpact(val eventCount: Int, val recipientCount: Int, val cancellationCount: Int)

/**
 * The fields of a calendar a person may change; a `null` field stays as it is. [useRemoteColor] clears the colour set
 * here, so an account calendar shows the provider's colour again.
 */
data class CalendarEdit(
    val name: String? = null,
    val color: String? = null,
    val notify: Boolean? = null,
    val hidden: Boolean? = null,
    val useRemoteColor: Boolean = false,
)

/** What the timeline of a window is shown with: the entries, the calendars they belong to and the new invitations. */
data class CalendarWindow(
    val timeline: CalendarTimeline,
    val calendars: List<CalendarInfo>,
    val pendingInvitations: Int
)

/** The calendar timeline and the writes that move, finish, copy and remove its events and tasks. */
interface CalendarRepository {
    /** Everything on the calendar from [from] to [to], both days included (at most 93 days). */
    suspend fun window(from: CalendarDay, to: CalendarDay): RepositoryResult<CalendarWindow>

    /** Changes the schedule of a stored entry, or of a series occurrence, which is stored first. */
    suspend fun reschedule(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<Unit>

    /** Marks a task done or open again; an occurrence of a series is stored first. */
    suspend fun setTaskDone(entry: CalendarEntry, done: Boolean): RepositoryResult<Unit>

    /** Puts a task into an event; the task is shown there until the event ends. Occurrences are stored first. */
    suspend fun putTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit>

    /** Copies an event or a task to [schedule]; answers the id of the copy. */
    suspend fun duplicate(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<String>

    /** Moves an event or a task to the trash, from which it can be restored for 30 days. */
    suspend fun delete(entry: CalendarEntry): RepositoryResult<Unit>

    /** Creates an event or a task; answers its id. */
    suspend fun create(draft: NewCalendarItem): RepositoryResult<String>
}

/**
 * What a person types into the new item sheet; the schedule is judged by the server's write rules. [place],
 * [calendarId], [url], [alertMinutes] and [travelMinutes] belong to an event, [flagged] to a task; [notes] and
 * [repeat] to both. [alertMinutes] counts the minutes before the start, [travelMinutes] the travel before it.
 */
data class NewCalendarItem(
    val kind: CalendarEntryKind,
    val title: String,
    val schedule: CalendarSchedule,
    val place: String?,
    val calendarId: String?,
    val notes: String? = null,
    val url: String? = null,
    val alertMinutes: Int? = null,
    val travelMinutes: Int? = null,
    val repeat: CalendarRepeat = CalendarRepeat.NEVER,
    val flagged: Boolean = false,
) {
    companion object {
        /** An alert comes at most four weeks before the start, as the server allows. */
        const val MAX_ALERT_MINUTES = 40_320

        /** Travel takes at least a minute and at most a day. */
        val TRAVEL_MINUTES = 1..1_440
    }
}

/**
 * How a new item repeats from its day: every day, Monday to Friday, on its weekday, on its day of the month, or on
 * its date every year. An event does not repeat yearly.
 */
enum class CalendarRepeat { NEVER, DAILY, WEEKDAYS, WEEKLY, MONTHLY, YEARLY }

/** The calendars list, the colours, visibility and notifications of each, and adding and removing calendars. */
interface CalendarCatalogRepository {
    suspend fun calendars(): RepositoryResult<List<CalendarInfo>>

    suspend fun edit(calendar: CalendarInfo, change: CalendarEdit): RepositoryResult<Unit>

    suspend fun create(name: String, color: String): RepositoryResult<String>

    suspend fun cancellationImpact(calendarId: String): RepositoryResult<CalendarCancellationImpact>

    suspend fun delete(calendarId: String): RepositoryResult<Unit>
}
