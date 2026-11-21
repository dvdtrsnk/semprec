package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** The longest range the timeline route serves, both days included. */
const val CALENDAR_MAX_WINDOW_DAYS: Int = 93

/**
 * Loads a window of the calendar and takes out what a hidden calendar owns. Hiding is a view preference: the items
 * stay where they are, so a hidden calendar's events are only left out here. A range the server would refuse is
 * [FailureKind.REJECTED] without a request.
 */
class LoadCalendarWindow(private val repository: CalendarRepository) {
    suspend operator fun invoke(from: CalendarDay, to: CalendarDay): RepositoryResult<CalendarWindow> {
        val days = to.epochDay - from.epochDay + 1
        if (days < 1 || days > CALENDAR_MAX_WINDOW_DAYS) return RepositoryResult.Failure(FailureKind.REJECTED)
        return when (val result = repository.window(from, to)) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> RepositoryResult.Content(result.value.withoutHidden())
        }
    }
}

private const val SYSTEM_SLEEP = "sleep"
private const val SYSTEM_TASKS = "tasks"

/**
 * Sleep nights and the traces of carried-over tasks carry no calendar of their own: they follow the system
 * calendars Sleep and Tasks, so hiding those hides them too.
 */
private fun CalendarWindow.withoutHidden(): CalendarWindow {
    val hidden = calendars.filter { it.hidden }
    val hiddenIds = hidden.map { it.id }.toSet()
    val hiddenKeys = hidden.mapNotNull { it.systemKey }.toSet()
    val shown = timeline.entries.filter { entry ->
        val byCalendar = entry.calendarId == null || entry.calendarId !in hiddenIds
        val bySleep = entry.kind != CalendarEntryKind.SLEEP || SYSTEM_SLEEP !in hiddenKeys
        val byTasks = entry.kind != CalendarEntryKind.TRACE || SYSTEM_TASKS !in hiddenKeys
        byCalendar && bySleep && byTasks
    }
    return copy(timeline = timeline.copy(entries = shown))
}

/** Whether a person may change an entry: a stored event or task, or an occurrence of a series. */
val CalendarEntry.isEditable: Boolean
    get() = (kind == CalendarEntryKind.EVENT || kind == CalendarEntryKind.TASK) && (!readOnly || isVirtualOccurrence)

/**
 * The writes of the calendar, each guarded by the rule that decides whether it applies: only a stored event or task
 * can be moved, finished, copied or removed, only a task can be done, and only a task can be put into an event.
 */
class EditCalendarEntry(private val repository: CalendarRepository) {
    suspend fun reschedule(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<Unit> =
        if (entry.isEditable && schedule != entry.schedule) {
            repository.reschedule(entry, schedule)
        } else {
            refused(entry.isEditable)
        }

    suspend fun toggleDone(entry: CalendarEntry): RepositoryResult<Unit> =
        if (entry.isEditable && entry.kind == CalendarEntryKind.TASK) {
            repository.setTaskDone(entry, !entry.isDone)
        } else {
            refused(false)
        }

    suspend fun putTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit> {
        val fits = task.isEditable && task.kind == CalendarEntryKind.TASK && event.isEditable &&
            event.kind == CalendarEntryKind.EVENT
        return if (fits) repository.putTaskInEvent(task, event) else refused(false)
    }

    suspend fun duplicate(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<String> =
        if (entry.isEditable) repository.duplicate(entry, schedule) else RepositoryResult.Failure(FailureKind.REJECTED)

    suspend fun delete(entry: CalendarEntry): RepositoryResult<Unit> =
        if (entry.isEditable) repository.delete(entry) else refused(false)

    /** A move to a place the entry already is changes nothing and is not an error. */
    private fun refused(editable: Boolean): RepositoryResult<Unit> =
        if (editable) RepositoryResult.Content(Unit) else RepositoryResult.Failure(FailureKind.REJECTED)
}

/** What creating a new item came to: the item, or a form the checks refused before the server was asked. */
sealed interface NewCalendarItemOutcome {
    data class Created(val itemId: String) : NewCalendarItemOutcome

    /** No title, a kind that is neither an event nor a task, or an option out of its range. */
    data object BreaksRules : NewCalendarItemOutcome
}

/** Creates a new event or task after the checks that need no server: a title and a schedule that fits its kind. */
class CreateCalendarItem(private val repository: CalendarRepository) {
    suspend operator fun invoke(draft: NewCalendarItem): RepositoryResult<NewCalendarItemOutcome> {
        val kindFits = draft.kind == CalendarEntryKind.EVENT || draft.kind == CalendarEntryKind.TASK
        val title = singleLineTitle(draft.title)
        if (!kindFits || title.isEmpty() || !draft.optionsFit()) {
            return RepositoryResult.Content(NewCalendarItemOutcome.BreaksRules)
        }
        val trimmed = draft.copy(
            title = title,
            place = draft.place?.trim()?.ifEmpty { null },
            notes = draft.notes?.trim()?.ifEmpty { null },
            url = draft.url?.trim()?.ifEmpty { null },
        )
        return when (val created = repository.create(trimmed)) {
            is RepositoryResult.Failure -> created
            is RepositoryResult.Content -> RepositoryResult.Content(NewCalendarItemOutcome.Created(created.value))
        }
    }
}

/**
 * An alert and a travel time are an event's, within the server's ranges; an event repeats at most monthly. A task
 * has neither.
 */
private fun NewCalendarItem.optionsFit(): Boolean {
    val alertFits = alertMinutes == null || alertMinutes in 0..NewCalendarItem.MAX_ALERT_MINUTES
    val travelFits = travelMinutes == null || travelMinutes in NewCalendarItem.TRAVEL_MINUTES
    return if (kind == CalendarEntryKind.EVENT) {
        alertFits && travelFits && repeat != CalendarRepeat.YEARLY
    } else {
        alertMinutes == null && travelMinutes == null
    }
}

/**
 * The calendars and the rules for changing them: a name is never empty, only an own calendar or one of an internet
 * account is renamed (the account's only here, not at the provider), and only an account calendar goes back to the
 * provider's colour.
 */
class EditCalendars(private val repository: CalendarCatalogRepository) {
    suspend fun edit(calendar: CalendarInfo, change: CalendarEdit): RepositoryResult<Unit> {
        val name = change.name?.trim()
        val renamable = calendar.kind == CalendarKind.OWN || calendar.kind == CalendarKind.ACCOUNT
        val renamesWrongly = name != null && (name.isEmpty() || !renamable)
        val resetsWrongly = change.useRemoteColor && calendar.kind != CalendarKind.ACCOUNT
        return if (renamesWrongly || resetsWrongly) {
            RepositoryResult.Failure(FailureKind.REJECTED)
        } else {
            repository.edit(calendar, change.copy(name = name))
        }
    }

    suspend fun create(name: String, color: String): RepositoryResult<String> =
        if (name.isBlank()) RepositoryResult.Failure(FailureKind.REJECTED) else repository.create(name.trim(), color)

    /** Only an own calendar that is not the default one can be deleted; an account calendar goes with its account. */
    suspend fun delete(calendar: CalendarInfo): RepositoryResult<Unit> =
        if (calendar.kind == CalendarKind.OWN && !calendar.isDefault) {
            repository.delete(calendar.id)
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }
}

/** Answers an invitation with the answers that fit it. */
class AnswerInvitation(private val repository: InvitationRepository) {
    suspend operator fun invoke(
        invitation: CalendarInvitation,
        answer: InvitationAnswer,
    ): RepositoryResult<Unit> =
        if (invitation.needsAnswer && answer.fits(invitation.kind)) {
            repository.respond(invitation.id, answer)
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }
}
