package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarWindow
import cz.semprec.app.domain.LoadCalendarWindow
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** Used when the host passes a day that is not `YYYY-MM-DD`; the first answer of the server then names today. */
private val FALLBACK_DAY = CalendarDay(2000, 1, 1)

private const val MONTHS_IN_YEAR = 12

internal fun initialCalendarState(initialDay: String): CalendarState {
    val day = CalendarDay.parse(initialDay) ?: FALLBACK_DAY
    return CalendarState(
        phase = CalendarPhase.LOADING,
        failure = null,
        zoom = CalendarZoom.DAY,
        selectedDay = day.toString(),
        today = day.toString(),
        nowMinutes = 0,
        days = emptyList(),
        monthGrid = monthGridOf(day),
        months = monthsOf(day.year),
        pendingInvitations = 0,
        selectedItemId = null,
        drag = null,
        clipboard = null,
        busy = false,
        problem = false,
        problemFailure = null,
    )
}

/**
 * Loads the window of the calendar around the selected day and keeps it up to date: the window covers the six weeks
 * of the selected month with a week on each side, so a day or a month is shown without a request, and a new one is
 * loaded when the month changes or when another screen changed the calendar data. A load supersedes the one before
 * it, and the content stays while a later load runs.
 */
abstract class CalendarWindowViewModel internal constructor(
    initialDay: String,
    private val loadWindow: LoadCalendarWindow,
    private val changes: CalendarChanges,
) : ScreenViewModel<CalendarState, CalendarAction, CalendarEffect>(initialCalendarState(initialDay)) {
    private var loadJob: Job? = null
    private var loadedMonth: Pair<Int, Int>? = null
    private var seenRevision = changes.revision.value
    private var entries: Map<String, CalendarEntry> = emptyMap()
    private var hosted: Map<String, CalendarEntry> = emptyMap()

    internal fun start() {
        load(showLoading = true)
        viewModelScope.launch {
            changes.revision.collect { revision ->
                if (revision != seenRevision) {
                    seenRevision = revision
                    load(showLoading = false)
                }
            }
        }
    }

    /** The entry with [id]: one of the window, or a task that is listed inside one of its events. */
    internal fun entryOf(id: String): CalendarEntry? = entries[id] ?: hosted[id]

    internal fun reload() = load(showLoading = false)

    internal fun retry() = load(showLoading = true)

    /** Shows [zoom] around [day]; a day in another month than the loaded one loads that month's window. */
    internal fun navigate(zoom: CalendarZoom, day: CalendarDay) {
        update {
            it.copy(
                zoom = zoom,
                selectedDay = day.toString(),
                monthGrid = monthGridOf(day),
                months = monthsOf(day.year),
                selectedItemId = null,
            )
        }
        if (loadedMonth != day.year to day.month) load(showLoading = false)
    }

    internal fun page(steps: Int) {
        val current = CalendarDay.parse(state.value.selectedDay) ?: return
        val next = when (state.value.zoom) {
            CalendarZoom.DAY -> current.plusDays(steps)
            CalendarZoom.MONTH -> current.plusMonths(steps)
            CalendarZoom.YEAR -> current.plusMonths(steps * MONTHS_IN_YEAR)
        }
        navigate(state.value.zoom, next)
    }

    private fun load(showLoading: Boolean) {
        loadJob?.cancel()
        val day = CalendarDay.parse(state.value.selectedDay) ?: FALLBACK_DAY
        val (from, to) = day.calendarWindow()
        if (showLoading) update { it.copy(phase = CalendarPhase.LOADING, failure = null) }
        loadJob = viewModelScope.launch {
            val result = guarded { loadWindow(from, to) }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> show(result.value, day, from, to)
                is RepositoryResult.Failure -> failed(result.kind)
                null -> failed(null)
            }
        }
    }

    private fun show(window: CalendarWindow, day: CalendarDay, from: CalendarDay, to: CalendarDay) {
        val timeline = window.timeline
        entries = timeline.entries.associateBy { it.id }
        hosted = hostedTasks(timeline.entries).filterKeys { it !in entries }
        loadedMonth = day.year to day.month
        val days = dayStatesOf(timeline.entries, from, to, CalendarColors(window.calendars))
        update {
            it.copy(
                phase = CalendarPhase.CONTENT,
                failure = null,
                today = timeline.today.toString(),
                nowMinutes = timeline.nowMinutes,
                days = days,
                pendingInvitations = window.pendingInvitations,
                selectedItemId = it.selectedItemId?.takeIf { id -> id in entries },
                drag = null,
                busy = false,
            )
        }
    }

    private fun failed(kind: FailureKind?) {
        update {
            if (it.days.isEmpty()) {
                it.copy(phase = CalendarPhase.ERROR, failure = kind, busy = false, drag = null)
            } else {
                it.copy(problem = true, problemFailure = kind, busy = false, drag = null)
            }
        }
    }
}
