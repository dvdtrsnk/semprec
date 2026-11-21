package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.CalendarRepeat
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.CreateCalendarItem
import cz.semprec.app.domain.NewCalendarItem
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.ScheduleEditing
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

enum class NewItemPhase { LOADING, EDITING, SAVING, FAILED }

/** What a new item is: an event on a calendar, or a task. */
enum class NewItemKind { EVENT, TASK }

/**
 * How a new item repeats from its day: every day, Monday to Friday, on its weekday, on its day of the month or every
 * year on its date. An event repeats at most monthly.
 */
enum class NewItemRepeat { NEVER, DAILY, WEEKDAYS, WEEKLY, MONTHLY, YEARLY }

/**
 * What a calendar's name is shown with when another calendar offered has the same name: nothing ([NONE]), the own
 * calendars' title ([OWN]), its account's name ([ACCOUNT_NAME]) or, when that name is missing or another account has
 * it too, its account's address ([ACCOUNT_ADDRESS]).
 */
enum class NewItemCalendarQualifier { NONE, OWN, ACCOUNT_NAME, ACCOUNT_ADDRESS }

/**
 * The internet account calendars are synced from, with its name and primary address when the server gave them. The
 * calendars whose account the server did not name share one with an empty [id].
 */
data class NewItemAccount(val id: String, val name: String?, val address: String?)

/** A calendar a new event can be put on; [account] is `null` for an own calendar. */
data class NewItemCalendar(
    val id: String,
    val name: String,
    val color: String,
    val isDefault: Boolean,
    val account: NewItemAccount? = null,
    val qualifier: NewItemCalendarQualifier = NewItemCalendarQualifier.NONE,
)

/** The calendars of one source: the own ones when [account] is `null`, else those of one internet account. */
data class NewItemCalendarGroup(val account: NewItemAccount?, val calendars: List<NewItemCalendar>)

/**
 * The new item sheet. [groups] are the calendars a new event can be put on, by where they come from: the own ones
 * first, then the writable ones of each internet account in the order the list names them; no group is empty.
 * [calendars] are the same calendars in one list. [defaultDay] is the day the sheet was opened for.
 * [failure] explains [NewItemPhase.FAILED]: [FailureKind.REJECTED] is a form the server or the rules refused (no
 * title, an end before the start).
 */
data class NewItemState(
    val phase: NewItemPhase,
    val failure: FailureKind?,
    val groups: List<NewItemCalendarGroup>,
    val defaultDay: String,
) {
    val calendars: List<NewItemCalendar>
        get() = groups.flatMap { it.calendars }
}

sealed interface NewItemAction {
    /**
     * Creates the item. [startMinutes] and [endMinutes] are times of day and are read only when [timed]; the end only
     * when [hasEnd]. [place] and [calendarId] apply to an event; an empty [calendarId] is the default calendar.
     * [endDay] is the last day of an event that lasts several days, empty for one that ends on [day]. [url],
     * [alertMinutes] (minutes before the start) and [travelMinutes] belong to an event, [flagged] to a task; `null`
     * is no alert or no travel time.
     */
    data class Create(
        val kind: NewItemKind,
        val title: String,
        val day: String,
        val timed: Boolean,
        val startMinutes: Int,
        val hasEnd: Boolean,
        val endMinutes: Int,
        val place: String,
        val calendarId: String,
        val endDay: String = "",
        val notes: String = "",
        val url: String = "",
        val alertMinutes: Int? = null,
        val travelMinutes: Int? = null,
        val repeat: NewItemRepeat = NewItemRepeat.NEVER,
        val flagged: Boolean = false,
    ) : NewItemAction

    /** The person changed a field: an earlier failure no longer applies. */
    data object Edited : NewItemAction
}

sealed interface NewItemEffect {
    /** The item exists; the sheet closes. */
    data class Created(val itemId: String) : NewItemEffect
}

/**
 * The form that adds an event or a task to the calendar. What is typed stays in the native fields and is handed over
 * by [NewItemAction.Create]; the title, the kind and the schedule are checked by the domain before the server is
 * asked, so a form that cannot work fails at once.
 */
class NewCalendarItemViewModel internal constructor(
    day: String,
    private val catalog: CalendarCatalogRepository,
    private val create: CreateCalendarItem,
) : ScreenViewModel<NewItemState, NewItemAction, NewItemEffect>(
    NewItemState(NewItemPhase.LOADING, null, emptyList(), day),
) {
    private var job: Job? = null

    init {
        loadCalendars()
    }

    override fun onAction(action: NewItemAction) {
        if (isClosed) return
        when (action) {
            is NewItemAction.Create -> if (state.value.phase != NewItemPhase.SAVING) save(action)
            NewItemAction.Edited -> if (state.value.phase == NewItemPhase.FAILED) {
                update { it.copy(phase = NewItemPhase.EDITING, failure = null) }
            }
        }
    }

    private fun loadCalendars() {
        job?.cancel()
        job = viewModelScope.launch {
            val result = guarded { catalog.calendars() }
            ensureActive()
            update {
                when (result) {
                    is RepositoryResult.Content -> it.copy(
                        phase = NewItemPhase.EDITING,
                        groups = newItemGroups(result.value.filter { it.takesNewEvents }),
                    )
                    // The form still works without the list: the server puts the event on the default calendar.
                    is RepositoryResult.Failure -> it.copy(phase = NewItemPhase.EDITING)
                    null -> it.copy(phase = NewItemPhase.EDITING)
                }
            }
        }
    }

    private fun save(action: NewItemAction.Create) {
        val draft = action.toDraft()
        if (draft == null) {
            update { it.copy(phase = NewItemPhase.FAILED, failure = FailureKind.REJECTED) }
            return
        }
        update { it.copy(phase = NewItemPhase.SAVING, failure = null) }
        job?.cancel()
        job = viewModelScope.launch {
            val result = guarded { create(draft) }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> emit(NewItemEffect.Created(result.value))
                is RepositoryResult.Failure -> update { it.copy(phase = NewItemPhase.FAILED, failure = result.kind) }
                null -> update { it.copy(phase = NewItemPhase.FAILED, failure = null) }
            }
        }
    }
}

/**
 * The calendars in their groups: the own ones, then one group per account in the order its first calendar is listed.
 * A calendar whose name another one has too is given the qualifier that tells them apart.
 */
private fun newItemGroups(calendars: List<CalendarInfo>): List<NewItemCalendarGroup> {
    val accounts = calendars.filter { it.kind == CalendarKind.ACCOUNT }
        .map { NewItemAccount(it.accountId.orEmpty(), it.accountName, it.accountAddress) }
        .distinctBy { it.id }
    val sharedNames = accounts.mapNotNull { it.name?.comparable() }.groupingBy { it }.eachCount()
        .filterValues { it > 1 }.keys
    val repeatedNames = calendars.groupingBy { it.name.comparable() }.eachCount().filterValues { it > 1 }.keys
    fun choice(calendar: CalendarInfo, account: NewItemAccount?): NewItemCalendar {
        val qualifier = when {
            calendar.name.comparable() !in repeatedNames -> NewItemCalendarQualifier.NONE
            account == null -> NewItemCalendarQualifier.OWN
            account.address != null && (account.name == null || account.name.comparable() in sharedNames) ->
                NewItemCalendarQualifier.ACCOUNT_ADDRESS
            else -> NewItemCalendarQualifier.ACCOUNT_NAME
        }
        return NewItemCalendar(calendar.id, calendar.name, calendar.color, calendar.isDefault, account, qualifier)
    }
    val own = calendars.filter { it.kind != CalendarKind.ACCOUNT }.map { choice(it, null) }
    val byAccount = accounts.map { account ->
        val members = calendars.filter { it.kind == CalendarKind.ACCOUNT && it.accountId.orEmpty() == account.id }
        NewItemCalendarGroup(account, members.map { choice(it, account) })
    }
    return listOfNotNull(NewItemCalendarGroup(null, own).takeIf { own.isNotEmpty() }) + byAccount
}

private fun String.comparable(): String = trim().lowercase()

/** The item the form describes, or `null` for a schedule that cannot be one. */
private fun NewItemAction.Create.toDraft(): NewCalendarItem? {
    val isEvent = kind == NewItemKind.EVENT
    return schedule(isEvent)?.let { schedule ->
        NewCalendarItem(
            kind = if (isEvent) CalendarEntryKind.EVENT else CalendarEntryKind.TASK,
            title = title,
            schedule = schedule,
            place = place.takeIf { it.isNotBlank() },
            calendarId = calendarId.takeIf { it.isNotEmpty() },
            notes = notes,
            url = url.takeIf { isEvent },
            alertMinutes = alertMinutes.takeIf { isEvent },
            travelMinutes = travelMinutes.takeIf { isEvent },
            repeat = repeat.toDomain(),
            flagged = flagged && !isEvent,
        )
    }
}

/**
 * The schedule the form describes, or `null` for a day that is no day, an end day before the first, or an end time
 * not after the start on the same day. Only an event ends on a later day.
 */
private fun NewItemAction.Create.schedule(isEvent: Boolean): CalendarSchedule? {
    val first = CalendarDay.parse(day)
    val last = if (isEvent && endDay.isNotEmpty()) CalendarDay.parse(endDay) else first
    return if (first != null && last != null && last >= first) times(first, last) else null
}

/** The times of a schedule from [first] to [last], or `null` when the end is not after the start. */
private fun NewItemAction.Create.times(first: CalendarDay, last: CalendarDay): CalendarSchedule? {
    val start = if (timed) ScheduleEditing.snap(startMinutes).coerceAtMost(ClockTime.DAY_MINUTES - 1) else null
    val end = if (timed && hasEnd) ScheduleEditing.snap(endMinutes) else null
    val orderly = start == null || end == null || last > first || end > start
    val endDate = last.takeIf { it > first }
    return if (orderly) CalendarSchedule(first, endDate, start?.let(::ClockTime), end?.let(::ClockTime)) else null
}

private fun NewItemRepeat.toDomain(): CalendarRepeat = when (this) {
    NewItemRepeat.NEVER -> CalendarRepeat.NEVER
    NewItemRepeat.DAILY -> CalendarRepeat.DAILY
    NewItemRepeat.WEEKDAYS -> CalendarRepeat.WEEKDAYS
    NewItemRepeat.WEEKLY -> CalendarRepeat.WEEKLY
    NewItemRepeat.MONTHLY -> CalendarRepeat.MONTHLY
    NewItemRepeat.YEARLY -> CalendarRepeat.YEARLY
}
