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
)

/** Where a calendar comes from: made by the person, filled by Semprec, or a subscription to a feed. */
enum class CalendarKind { OWN, SYSTEM, SUBSCRIPTION }

/** What deleting a calendar cancels: its events, the people who were invited and the cancellations sent. */
data class CalendarCancellationImpact(val eventCount: Int, val recipientCount: Int, val cancellationCount: Int)

/** The fields of a calendar a person may change. */
data class CalendarEdit(
    val name: String? = null,
    val color: String? = null,
    val notify: Boolean? = null,
    val hidden: Boolean? = null,
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

/** What a person types into the new item sheet; the schedule is judged by the server's write rules. */
data class NewCalendarItem(
    val kind: CalendarEntryKind,
    val title: String,
    val schedule: CalendarSchedule,
    val place: String?,
    val calendarId: String?,
)

/** The calendars list, the colours, visibility and notifications of each, and adding and removing calendars. */
interface CalendarCatalogRepository {
    suspend fun calendars(): RepositoryResult<List<CalendarInfo>>

    suspend fun edit(calendar: CalendarInfo, change: CalendarEdit): RepositoryResult<Unit>

    suspend fun create(name: String, color: String): RepositoryResult<String>

    suspend fun cancellationImpact(calendarId: String): RepositoryResult<CalendarCancellationImpact>

    suspend fun delete(calendarId: String): RepositoryResult<Unit>
}
