package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.AreaOverview
import cz.semprec.app.domain.LoadAreaOverview
import cz.semprec.app.domain.SetAreaActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val TASKS_KEY = "tasks"
private const val THREADS_KEY = "threads"

/**
 * One area: what is coming up in it, what is connected to it and whether it shows on the overview. [today] is
 * `yyyy-MM-dd`, asked whenever the area is read. A refresh keeps the content on screen; a newer read supersedes the
 * one before it.
 */
class AreaViewModel internal constructor(
    private val areaId: String,
    private val today: () -> String,
    private val load: LoadAreaOverview,
    private val setActive: SetAreaActive,
) : ScreenViewModel<AreaState, AreaAction, AreaEffect>(AreaState()) {
    private var loadJob: Job? = null
    private var version: String? = null

    init {
        read(showWait = true)
    }

    override fun onAction(action: AreaAction) {
        if (isClosed) return
        when (action) {
            AreaAction.Retry -> read(showWait = true)
            AreaAction.Refresh -> read(showWait = state.value.phase != AreaPhase.CONTENT)
            is AreaAction.OpenTasks -> emit(AreaEffect.OpenTasks(action.todayOnly))
            is AreaAction.OpenUpcoming -> state.value.upcoming.firstOrNull { it.id == action.id }
                ?.let { emit(AreaEffect.OpenDetails(it.kind, it.id)) }
            is AreaAction.OpenRelated -> openRelated(action.databaseId)
            AreaAction.OpenNotes -> emit(AreaEffect.OpenNotes)
            is AreaAction.SetActive -> write(action.on)
            AreaAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun openRelated(databaseId: String) {
        val related = state.value.related.firstOrNull { it.databaseId == databaseId } ?: return
        emit(
            when (related.databaseKey) {
                TASKS_KEY -> AreaEffect.OpenTasks(todayOnly = false)
                THREADS_KEY -> AreaEffect.OpenMail
                else -> AreaEffect.OpenCollection(related.target())
            },
        )
    }

    private fun read(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) AreaState() else it }
        loadJob = viewModelScope.launch {
            val result = answer { load(areaId, today()) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> {
                        version = result.value.version
                        result.value.toState()
                    }
                    is Answer.Rejected ->
                        if (it.phase == AreaPhase.CONTENT) it else AreaState(AreaPhase.ERROR, result.kind)
                }
            }
        }
    }

    private fun write(on: Boolean) {
        val base = version
        if (base == null || !state.value.canSet(on)) return
        update { it.copy(activeSaving = true, writeFailure = null) }
        viewModelScope.launch {
            val result = answer { setActive(areaId, base, on) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> {
                        version = result.value
                        it.copy(active = on, activeSaving = false)
                    }
                    is Answer.Rejected -> it.copy(activeSaving = false, writeFailure = Failed(result.kind))
                }
            }
        }
    }
}

private fun AreaOverview.toState() = AreaState(
    phase = AreaPhase.CONTENT,
    name = name,
    color = color,
    icon = icon,
    active = active,
    tasksToday = tasksToday,
    tasksOpen = tasksOpen,
    eventsSoon = eventsSoon,
    upcoming = upcoming.map {
        AreaUpcomingItem(it.kind, it.id, it.title, it.date, it.timeFrom, it.timeTo, it.projectTitle, it.projectColor)
    },
    related = related.map {
        AreaRelatedItem(it.databaseId, it.databaseKey, it.name, it.icon, it.color, it.count, it.filter?.json)
    },
)

/** The items of the collection that belong to the area: what its filter selects, or the whole collection. */
private fun AreaRelatedItem.target(): CollectionTarget =
    filterJson?.let { CollectionTarget.Matching(databaseKey, databaseId, it) }
        ?: CollectionTarget.Whole(databaseKey, databaseId)

/** A switch is sent only once the area is shown, while no other is in flight, and when it changes the value. */
private fun AreaState.canSet(on: Boolean): Boolean = phase == AreaPhase.CONTENT && !activeSaving && active != on
