package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CalendarAgendaPage
import cz.alldots.app.domain.CalendarAgendaRepository
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.CalendarEntry
import cz.alldots.app.domain.CalendarEntryKind
import cz.alldots.app.domain.agendaDays
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
    private var entries: List<CalendarEntry> = emptyList()

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
        entries = entries + page.entries.filter { it.toAgenda() != null }
        val days = entries.agendaDays().map { (day, list) ->
            CalendarAgendaDay(day.toString(), list.mapNotNull { it.toAgenda() })
        }
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
        val entry = entries.firstOrNull { it.id == id }?.toAgenda() ?: return
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
