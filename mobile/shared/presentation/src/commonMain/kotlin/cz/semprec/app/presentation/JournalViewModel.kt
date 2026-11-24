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
import cz.semprec.app.domain.journalAxisWindowContains
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
 *
 * The windows of the axis stay where they are while the person selects periods inside them, so the screen can scroll
 * the axis to a new selection without its cells changing under the scroll; they move only to a day the person moved
 * the axis to ([JournalAction.ShowAxisAround]) or to a selection outside them.
 *
 * Once a period is shown, the one before and the one after it (the neighbouring day, month or year) are read in the
 * background and kept, with a few read before them: selecting a kept period shows it at once, and the period is
 * read again behind it, its answer replacing the kept one. A write elsewhere drops what is kept.
 */
class JournalViewModel internal constructor(
    initialDay: String,
    private val loadPeriod: LoadJournalPeriod,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<JournalState, JournalAction, JournalEffect>(initialState(initialDay)) {
    private var loadJob: Job? = null
    private var prefetchJob: Job? = null

    /** The last periods read, newest last, for a selection of one of them to show at once. */
    private val kept = LinkedHashMap<JournalPeriod, JournalPeriodPage>()

    /** The day the windows of the axis lie around. */
    private var around: CalendarDay = CalendarDay.parse(state.value.selection.start) ?: FALLBACK_DAY

    init {
        // After a write elsewhere in the window, what the shown period lists around its page (its weeks, quarters,
        // events, birthdays and Inbox) is read again. The page and the axis stay as they are, and a load already running is
        // not interrupted.
        reloadOnChanges(changes) {
            // A period still being read ahead was asked for before the write: its answer must not be kept.
            prefetchJob?.cancel()
            kept.clear()
            update { it.withNeighbours() }
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
                        keep(period, result.value)
                        update { it.around(result.value) }
                        prefetchAround(state.value.selection)
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
        val selectable = kind != JournalPeriodKind.QUARTER && kind != JournalPeriodKind.WEEK
        if (!selectable || day == null || selection == null) return
        if (reloads) {
            // Over a shown period, the axis moves to the new selection at once while the period it shows stays until
            // the new one arrives, so the screen changes in place instead of passing through a loading state.
            val keepsContent = current.phase == JournalPhase.CONTENT
            if (!journalAxisWindowContains(around, day)) around = day
            update { it.copy(selection = selection, axis = axisFor(selection, it.today, around)) }
            load(keepsContent)
        } else {
            // The same period again: nothing to load, but the axis returns to it from wherever it was moved.
            if (!journalAxisWindowContains(around, day)) around = day
            update { it.copy(axis = axisFor(it.selection, it.today, around)) }
        }
    }

    /** A day that does not parse leaves the axis where it is. */
    private fun showAxisAround(day: String) {
        around = CalendarDay.parse(day) ?: return
        update { it.copy(axis = axisFor(it.selection, it.today, around)) }
    }

    /**
     * Loads the selected period; with [keepsContent] the period shown so far stays until the answer replaces it. A
     * kept period shows at once and stays when it cannot be read again.
     */
    private fun load(keepsContent: Boolean = false) {
        loadJob?.cancel()
        val selection = state.value.selection
        val period = selection.toPeriod()
        val keptPage = kept[period]
        if (keptPage != null) {
            show(keptPage, selection)
        } else if (!keepsContent) {
            update { loading(it, around) }
        }
        loadJob = viewModelScope.launch {
            val result = try {
                loadPeriod(period)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            when {
                result is RepositoryResult.Content -> {
                    keep(period, result.value)
                    show(result.value, selection)
                    prefetchAround(selection)
                }
                keptPage != null -> Unit
                result is RepositoryResult.Failure -> update { failed(it, around, result.kind) }
                else -> update { failed(it, around, null) }
            }
        }
    }

    /** Reads the periods beside [selection] that are not kept yet, one after the other, and keeps them. */
    private fun prefetchAround(selection: JournalSelection) {
        prefetchJob?.cancel()
        val missing = selection.neighbours().filter { it !in kept }
        if (missing.isEmpty()) return
        prefetchJob = viewModelScope.launch {
            for (period in missing) {
                val result = try {
                    loadPeriod(period)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    null
                }
                ensureActive()
                if (result is RepositoryResult.Content) keep(period, result.value)
            }
        }
    }

    /** Keeps [page] and, when it lies beside the shown period, lays it out there. */
    private fun keep(period: JournalPeriod, page: JournalPeriodPage) {
        kept.remove(period)
        kept[period] = page
        while (kept.size > KEPT_PERIODS) kept.remove(kept.keys.first())
        update { it.withNeighbours() }
    }

    private fun show(page: JournalPeriodPage, selection: JournalSelection) {
        val content = page.toContent(selection)
        update {
            it.copy(
                phase = JournalPhase.CONTENT,
                failure = null,
                shown = selection,
                today = page.today.toString(),
                axis = axisFor(it.selection, page.today.toString(), around),
                page = content.page,
                weeks = content.weeks,
                quarters = content.quarters,
                events = content.events,
                birthdays = content.birthdays,
                inbox = content.inbox,
            ).withNeighbours()
        }
    }

    /** [this] with the kept periods beside the shown one, or without them where none is kept. */
    private fun JournalState.withNeighbours(): JournalState {
        val shown = shown ?: return copy(before = null, after = null)
        val (after, before) = shown.neighbourStarts()
        return copy(before = neighbour(before, shown.kind), after = neighbour(after, shown.kind))
    }

    private fun neighbour(start: CalendarDay, kind: JournalPeriodKind): JournalPeriodContent? =
        kept[JournalPeriod.containing(kind.toType(), start)]?.toContent(JournalSelection(kind, start.toString()))
}

/** What [this] page shows for [selection]: a month has no note of its own. */
private fun JournalPeriodPage.toContent(selection: JournalSelection): JournalPeriodContent {
    val ref = JournalPageRef(period.type.toKind(), period.key)
    return JournalPeriodContent(
        shown = selection,
        page = if (period.type == JournalPeriodType.MONTH) null else pageState(ref, markdown),
        weeks = weeks.map { week -> week.toState() },
        quarters = quarters.map { quarter -> quarter.toState() },
        events = events.map { event -> event.toState() },
        birthdays = birthdays.map { birthday -> JournalBirthdayState(birthday.id, birthday.personName) },
        inbox = inbox.map { entry -> entry.toState() },
    )
}

private fun initialState(initialDay: String): JournalState {
    val day = CalendarDay.parse(initialDay) ?: FALLBACK_DAY
    val selection = JournalSelection(JournalPeriodKind.DAY, day.toString())
    return JournalState(JournalPhase.LOADING, selection, day.toString(), axisFor(selection, day.toString()))
}

/** How many periods read are kept: the shown one, its neighbours and a few shown before them. */
private const val KEPT_PERIODS = 9
private const val MONTHS_IN_YEAR = 12

/** The period after the selected one and the one before it, of the same kind. */
private fun JournalSelection.neighbours(): List<JournalPeriod> =
    neighbourStarts().map { day -> JournalPeriod.containing(kind.toType(), day) }

/** The first days of the period after the selected one and of the one before it, of the same kind. */
private fun JournalSelection.neighbourStarts(): List<CalendarDay> {
    val type = kind.toType()
    val start = (CalendarDay.parse(start) ?: FALLBACK_DAY).startOf(type)
    return listOf(1, -1).map { step ->
        when (type) {
            JournalPeriodType.DAY -> start.plusDays(step)
            JournalPeriodType.WEEK -> start.plusDays(step * DAYS_IN_WEEK)
            JournalPeriodType.MONTH -> start.plusMonths(step)
            JournalPeriodType.QUARTER -> start.plusMonths(step * MONTHS_IN_QUARTER)
            JournalPeriodType.YEAR -> start.plusMonths(step * MONTHS_IN_YEAR)
        }
    }
}

private const val DAYS_IN_WEEK = 7
private const val MONTHS_IN_QUARTER = 3

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

private fun loading(state: JournalState, around: CalendarDay) = state.copy(
    phase = JournalPhase.LOADING,
    shown = null,
    before = null,
    after = null,
    failure = null,
    axis = axisFor(state.selection, state.today, around),
    page = null,
    weeks = emptyList(),
    quarters = emptyList(),
    events = emptyList(),
    birthdays = emptyList(),
    inbox = emptyList(),
)

private fun failed(state: JournalState, around: CalendarDay, failure: FailureKind?) =
    loading(state, around).copy(phase = JournalPhase.ERROR, failure = failure)

/** [this] with what [page] lists around its own page: its weeks, quarters, events, birthdays and Inbox. */
private fun JournalState.around(page: JournalPeriodPage) = copy(
    weeks = page.weeks.map { week -> week.toState() },
    quarters = page.quarters.map { quarter -> quarter.toState() },
    events = page.events.map { event -> event.toState() },
    birthdays = page.birthdays.map { birthday -> JournalBirthdayState(birthday.id, birthday.personName) },
    inbox = page.inbox.map { entry -> entry.toState() },
)
