package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.CreateCalendarItem
import cz.semprec.app.domain.NewCalendarItem
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.ScheduleEditing
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

enum class NewItemPhase { LOADING, EDITING, SAVING, FAILED }

/** What a new item is: an event on a calendar, or a task. */
enum class NewItemKind { EVENT, TASK }

/** A calendar a new event can be put on. */
data class NewItemCalendar(val id: String, val name: String, val color: String, val isDefault: Boolean)

/**
 * The new item sheet. [calendars] are the calendars of the person, [defaultDay] the day the sheet was opened for.
 * [failure] explains [NewItemPhase.FAILED]: [FailureKind.REJECTED] is a form the server or the rules refused (no
 * title, an end before the start).
 */
data class NewItemState(
    val phase: NewItemPhase,
    val failure: FailureKind?,
    val calendars: List<NewItemCalendar>,
    val defaultDay: String,
)

sealed interface NewItemAction {
    /**
     * Creates the item. [startMinutes] and [endMinutes] are times of day and are read only when [timed]; the end only
     * when [hasEnd]. [place] and [calendarId] apply to an event; an empty [calendarId] is the default calendar.
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
                        calendars = result.value.filter { it.kind == CalendarKind.OWN }.map { it.toChoice() },
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

private fun CalendarInfo.toChoice() = NewItemCalendar(id, name, color, isDefault)

/** The item the form describes, or `null` for a day or a time that cannot be one. */
private fun NewItemAction.Create.toDraft(): NewCalendarItem? {
    val first = CalendarDay.parse(day)
    val start = if (timed) ScheduleEditing.snap(startMinutes).coerceAtMost(ClockTime.DAY_MINUTES - 1) else null
    val end = if (timed && hasEnd) ScheduleEditing.snap(endMinutes) else null
    val orderly = start == null || end == null || end > start
    if (first == null || !orderly) return null
    val schedule = Schedule(first, null, start?.let { ClockTime(it) }, end?.let { ClockTime(it) })
    val entryKind = if (kind == NewItemKind.EVENT) CalendarEntryKind.EVENT else CalendarEntryKind.TASK
    val inPlace = place.takeIf { it.isNotBlank() }
    return NewCalendarItem(entryKind, title, schedule, inPlace, calendarId.takeIf { it.isNotEmpty() })
}
