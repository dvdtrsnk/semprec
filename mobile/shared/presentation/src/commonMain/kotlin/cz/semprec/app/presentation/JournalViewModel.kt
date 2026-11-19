package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodPage
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.LoadJournalPeriod
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.journalAxis
import cz.semprec.app.domain.startOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/** Used when the host passes a day that is not `YYYY-MM-DD`; the first answer of the server then names today. */
private val FALLBACK_DAY = CalendarDay(2000, 1, 1)

/**
 * The diary: the selected period of the time axis with its note, and for a day its events, birthdays and Inbox. A
 * change of selection supersedes the load before it. The notes themselves are edited in the note editor.
 */
class JournalViewModel internal constructor(
    initialDay: String,
    private val loadPeriod: LoadJournalPeriod,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<JournalState, JournalAction, JournalEffect>(initialState(initialDay)) {
    private var loadJob: Job? = null

    init {
        // After a write elsewhere in the window, what the shown period lists around its page (its weeks, events,
        // birthdays and Inbox) is read again. The page and the axis stay as they are, and a load already running is
        // not interrupted.
        reloadOnChanges(changes) {
            if (state.value.phase == JournalPhase.CONTENT && loadJob?.isActive != true) {
                val period = state.value.selection.toPeriod()
                loadJob = viewModelScope.launch {
                    val result = try {
                        loadPeriod(period)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        null
                    }
                    ensureActive()
                    if (result is RepositoryResult.Content && state.value.selection.toPeriod() == period) {
                        update { it.around(result.value) }
                    }
                }
            }
        }
        load()
    }

    override fun onAction(action: JournalAction) {
        if (isClosed) return
        when (action) {
            JournalAction.Retry -> load()
            is JournalAction.Select -> select(action.kind, action.start)
            is JournalAction.ShowAxisAround -> showAxisAround(action.day)
            JournalAction.GoToday -> select(JournalPeriodKind.DAY, state.value.today)
            is JournalAction.OpenEvent -> emit(JournalEffect.OpenEvent(action.id))
            JournalAction.OpenInbox -> emit(JournalEffect.OpenInbox)
        }
    }

    private fun select(kind: JournalPeriodKind, start: String) {
        val day = CalendarDay.parse(start)?.startOf(kind.toType())
        val selection = day?.let { JournalSelection(kind, it.toString()) }
        val current = state.value
        val reloads = selection != current.selection || current.phase == JournalPhase.ERROR
        if (kind == JournalPeriodKind.WEEK || selection == null) return
        if (reloads) {
            update { it.copy(selection = selection) }
            load()
        } else {
            // The same period again: nothing to load, but the axis returns to it from wherever it was moved.
            update { it.copy(axis = axisFor(it.selection, it.today)) }
        }
    }

    /** A day that does not parse leaves the axis where it is. */
    private fun showAxisAround(day: String) {
        val around = CalendarDay.parse(day) ?: return
        update { it.copy(axis = axisFor(it.selection, it.today, around)) }
    }

    private fun load() {
        loadJob?.cancel()
        val selection = state.value.selection
        val period = selection.toPeriod()
        update { loading(it) }
        loadJob = viewModelScope.launch {
            val result = try {
                loadPeriod(period)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> show(result.value)
                is RepositoryResult.Failure -> update { failed(it, result.kind) }
                null -> update { failed(it, null) }
            }
        }
    }

    private fun show(page: JournalPeriodPage) {
        val ref = JournalPageRef(page.period.type.toKind(), page.period.key)
        val own = if (page.period.type == JournalPeriodType.MONTH) null else pageState(ref, page.markdown)
        update {
            it.copy(
                phase = JournalPhase.CONTENT,
                failure = null,
                today = page.today.toString(),
                axis = axisFor(it.selection, page.today.toString()),
                page = own,
                weeks = page.weeks.map { week -> week.toState() },
                events = page.events.map { event -> event.toState() },
                birthdays = page.birthdays.map { birthday -> JournalBirthdayState(birthday.id, birthday.personName) },
                inbox = page.inbox.map { entry -> entry.toState() },
            )
        }
    }
}

private fun initialState(initialDay: String): JournalState {
    val day = CalendarDay.parse(initialDay) ?: FALLBACK_DAY
    val selection = JournalSelection(JournalPeriodKind.DAY, day.toString())
    return JournalState(JournalPhase.LOADING, selection, day.toString(), axisFor(selection, day.toString()))
}

private fun JournalSelection.toPeriod(): JournalPeriod {
    val day = CalendarDay.parse(start) ?: FALLBACK_DAY
    return JournalPeriod.containing(kind.toType(), day)
}

private fun axisFor(
    selection: JournalSelection,
    today: String,
    around: CalendarDay? = null,
): List<JournalAxisRowState> {
    val start = CalendarDay.parse(selection.start) ?: FALLBACK_DAY
    val todayDay = CalendarDay.parse(today) ?: start
    return journalAxis(selection.kind.toType(), start, todayDay, around ?: start).toState()
}

private fun loading(state: JournalState) = state.copy(
    phase = JournalPhase.LOADING,
    failure = null,
    axis = axisFor(state.selection, state.today),
    page = null,
    weeks = emptyList(),
    events = emptyList(),
    birthdays = emptyList(),
    inbox = emptyList(),
)

private fun failed(state: JournalState, failure: FailureKind?) =
    loading(state).copy(phase = JournalPhase.ERROR, failure = failure)

/** [this] with what [page] lists around its own page: its weeks, events, birthdays and Inbox. */
private fun JournalState.around(page: JournalPeriodPage) = copy(
    weeks = page.weeks.map { week -> week.toState() },
    events = page.events.map { event -> event.toState() },
    birthdays = page.birthdays.map { birthday -> JournalBirthdayState(birthday.id, birthday.personName) },
    inbox = page.inbox.map { entry -> entry.toState() },
)
