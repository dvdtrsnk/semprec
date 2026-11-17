package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarAgendaPage
import cz.semprec.app.domain.CalendarAgendaRepository
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The calendar as a list: the stored events and tasks from [from] (`YYYY-MM-DD`) on, by day, a page at a time. A
 * retry supersedes the reads before it, and a page that comes after it is not shown. A [from] that is no day is
 * invalid data, and nothing is read.
 */
class CalendarAgendaViewModel internal constructor(
    from: String,
    private val repository: CalendarAgendaRepository,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<CalendarAgendaState, CalendarAgendaAction, CalendarAgendaEffect>(CalendarAgendaState()) {
    private val first: CalendarDay? = CalendarDay.parse(from)
    private var job: Job? = null
    private var cursor: String? = null
    private var entries: List<CalendarAgendaEntry> = emptyList()
    private var entryDays: Map<String, String> = emptyMap()

    init {
        reloadOnChanges(changes) { load() }
        load()
    }

    override fun onAction(action: CalendarAgendaAction) {
        if (isClosed) return
        when (action) {
            CalendarAgendaAction.Retry -> load()
            CalendarAgendaAction.LoadMore -> loadMore()
            is CalendarAgendaAction.Open -> open(action.id)
        }
    }

    private fun load() {
        job?.cancel()
        cursor = null
        entries = emptyList()
        entryDays = emptyMap()
        val day = first
        if (day == null) {
            update { CalendarAgendaState(phase = CalendarAgendaPhase.ERROR, failure = FailureKind.INVALID_DATA) }
            return
        }
        update { CalendarAgendaState() }
        job = viewModelScope.launch {
            val read = answer { repository.page(day, null) }
            ensureActive()
            when (read) {
                is Answer.Done -> show(read.value)
                is Answer.Rejected ->
                    update { CalendarAgendaState(phase = CalendarAgendaPhase.ERROR, failure = read.kind) }
            }
        }
    }

    private fun loadMore() {
        val next = cursor
        val day = first
        val current = state.value
        val idle = !current.loadingMore && current.phase == CalendarAgendaPhase.CONTENT
        if (next == null || day == null || !idle) return
        update { it.copy(loadingMore = true, moreFailure = null) }
        job = viewModelScope.launch {
            val read = answer { repository.page(day, next) }
            ensureActive()
            when (read) {
                is Answer.Done -> show(read.value)
                is Answer.Rejected -> update { it.copy(loadingMore = false, moreFailure = Failed(read.kind)) }
            }
        }
    }

    private fun show(page: CalendarAgendaPage) {
        cursor = page.nextCursor
        val added = page.entries.mapNotNull { entry -> entry.toAgenda()?.let { entry.date.toString() to it } }
        entryDays = entryDays + added.associate { (day, entry) -> entry.id to day }
        entries = entries + added.map { it.second }
        val days = entries.groupBy { entryDays.getValue(it.id) }.map { (day, list) -> CalendarAgendaDay(day, list) }
        update {
            it.copy(
                phase = CalendarAgendaPhase.CONTENT,
                failure = null,
                days = days,
                hasMore = page.nextCursor != null,
                loadingMore = false,
                moreFailure = null,
            )
        }
    }

    private fun open(id: String) {
        val entry = entries.firstOrNull { it.id == id } ?: return
        emit(CalendarAgendaEffect.OpenDetails(entry.kind, entry.id))
    }
}

/** An event or a task as the agenda shows it; the agenda has no derived entries, and any other kind is left out. */
private fun CalendarEntry.toAgenda(): CalendarAgendaEntry? {
    val agendaKind = when (kind) {
        CalendarEntryKind.EVENT -> CalendarAgendaKind.EVENT
        CalendarEntryKind.TASK -> CalendarAgendaKind.TASK
        else -> return null
    }
    return CalendarAgendaEntry(
        id = id,
        kind = agendaKind,
        title = title,
        timeFrom = timeFrom?.toString(),
        timeTo = timeTo?.toString(),
        allDay = allDay,
        done = isDone,
        place = place,
    )
}
