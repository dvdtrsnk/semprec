package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.EditJournalPage
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodPage
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.LoadJournalPeriod
import cz.semprec.app.domain.PageEdit
import cz.semprec.app.domain.PageEditOutcome
import cz.semprec.app.domain.PageTarget
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.journalAxis
import cz.semprec.app.domain.startOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** Used when the host passes a day that is not `YYYY-MM-DD`; the first answer of the server then names today. */
private val FALLBACK_DAY = CalendarDay(2000, 1, 1)

/**
 * The diary: the selected period of the time axis with its note, and for a day its events, birthdays and Inbox. A
 * change of selection supersedes the load before it. A change to a note is read, applied and written by
 * [EditJournalPage] and answers with the page as the server now has it; while one is written further changes are
 * ignored.
 */
class JournalViewModel internal constructor(
    initialDay: String,
    private val loadPeriod: LoadJournalPeriod,
    private val editPage: EditJournalPage,
) : ScreenViewModel<JournalState, JournalAction, JournalEffect>(initialState(initialDay)) {
    private var loadJob: Job? = null
    private var editJob: Job? = null
    private var itemIds: Map<JournalPageRef, String> = emptyMap()

    init {
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
            is JournalAction.OpenPage -> emit(JournalEffect.OpenPage(action.pageId, action.title))
            is JournalAction.SetText -> setText(action)
            is JournalAction.ToggleDone -> toggleDone(action)
            is JournalAction.AddBlock -> addBlock(action)
            JournalAction.DismissProblem -> update { it.copy(editProblem = null, editFailure = null) }
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
        editJob?.cancel()
        itemIds = emptyMap()
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
        itemIds = buildMap {
            page.itemId?.let { put(ref, it) }
            for (week in page.weeks) {
                week.itemId?.let { put(JournalPageRef(JournalPeriodKind.WEEK, week.period), it) }
            }
        }
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

    private fun setText(action: JournalAction.SetText) {
        val block = blockOf(action.page, action.index)
        val expected = block?.runs?.joinToString("") { it.text }
        if (block != null && block.kind != JournalBlockKind.PAGE && expected != action.text) {
            edit(action.page, PageEdit.SetText(action.index, expected.orEmpty(), action.text))
        }
    }

    private fun toggleDone(action: JournalAction.ToggleDone) {
        val block = blockOf(action.page, action.index)
        if (block != null && block.kind == JournalBlockKind.TODO) {
            edit(action.page, PageEdit.ToggleDone(action.index, block.runs.joinToString("") { it.text }))
        }
    }

    private fun addBlock(action: JournalAction.AddBlock) {
        if (action.kind != JournalBlockKind.PAGE && action.text.isNotBlank()) {
            edit(action.page, PageEdit.Append(action.kind.toType(), action.text))
        }
    }

    private fun edit(ref: JournalPageRef, change: PageEdit) {
        if (state.value.saving || state.value.phase != JournalPhase.CONTENT) return
        update { it.copy(saving = true, editProblem = null, editFailure = null) }
        val target = PageTarget.OfPeriod(JournalPeriod(ref.kind.toType(), ref.period), itemIds[ref])
        editJob = viewModelScope.launch {
            val result = try {
                editPage(target, change)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> applyOutcome(ref, result.value)
                is RepositoryResult.Failure -> update {
                    it.copy(saving = false, editProblem = JournalEditProblem.FAILED, editFailure = result.kind)
                }
                null -> update { it.copy(saving = false, editProblem = JournalEditProblem.FAILED) }
            }
        }
    }

    private fun applyOutcome(ref: JournalPageRef, outcome: PageEditOutcome) {
        when (outcome) {
            is PageEditOutcome.Saved -> {
                itemIds = itemIds + (ref to outcome.itemId)
                val written = pageState(ref, outcome.markdown)
                update { it.withPage(written).copy(saving = false) }
            }
            PageEditOutcome.Stale -> update { it.copy(saving = false, editProblem = JournalEditProblem.STALE) }
        }
    }

    private fun blockOf(ref: JournalPageRef, index: Int): JournalBlock? {
        val current = state.value
        val pages = listOfNotNull(current.page) + current.weeks.map { it.page }
        return pages.firstOrNull { it.ref == ref }?.blocks?.getOrNull(index)
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
    saving = false,
    editProblem = null,
    editFailure = null,
)

private fun failed(state: JournalState, failure: FailureKind?) =
    loading(state).copy(phase = JournalPhase.ERROR, failure = failure)

/** The state with the page [written] in place of the page of the same period, wherever the screen shows it. */
private fun JournalState.withPage(written: JournalPageState): JournalState = copy(
    page = page?.let { if (it.ref == written.ref) written else it },
    weeks = weeks.map { if (it.page.ref == written.ref) it.copy(page = written) else it },
)
