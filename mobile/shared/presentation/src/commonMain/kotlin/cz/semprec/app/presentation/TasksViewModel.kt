package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.TasksTab
import cz.semprec.app.domain.CatalogRepository
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.NewTask
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TaskRepository
import cz.semprec.app.domain.TaskScope
import cz.semprec.app.domain.WorkItem
import cz.semprec.app.domain.map
import cz.semprec.app.domain.singleLineTitle
import cz.semprec.app.domain.then
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where the Tasks screen starts: a tab and, for the lists an area or a project links to, a filter. */
data class TasksStart(
    val tab: TasksTab = TasksTab.TODAY,
    val hideDone: Boolean = false,
    val areaId: String? = null,
    val projectId: String? = null,
)

/** What the Tasks screen is made of: the task repository, its writes and the catalogs of areas and projects. */
internal class TasksDependencies(
    val tasks: TaskRepository,
    val items: ItemRepository,
    val catalog: CatalogRepository,
    val changes: ItemChanges,
)

/**
 * The Tasks screen: one list for every start ([TasksStart]). The tab decides what is asked of the server; the filter
 * and the hidden done tasks only change what is shown of it. A write shows at once and is undone with a notice when it
 * fails; a newer load supersedes an older one, and so does closing the screen.
 */
class TasksViewModel internal constructor(
    private val dependencies: TasksDependencies,
    private val today: () -> String,
    start: TasksStart,
) : ScreenViewModel<TasksState, TasksAction, TasksEffect>(
    TasksState(
        tab = start.tab,
        hideDone = start.hideDone,
        areaId = start.areaId,
        projectId = start.projectId,
    ),
) {
    private var loaded: List<WorkItem> = emptyList()
    private var catalog = TasksCatalog()
    private var loadJob: Job? = null
    private val writes = Mutex()

    init {
        load(silent = false)
        viewModelScope.launch { dependencies.changes.events.collect { load(silent = true) } }
    }

    override fun onAction(action: TasksAction) {
        if (isClosed) return
        when (action) {
            is TasksAction.SelectTab -> if (action.tab != state.value.tab) {
                update { it.copy(tab = action.tab) }
                load(silent = false)
            }
            TasksAction.ToggleHideDone, is TasksAction.SetArea, is TasksAction.SetProject,
            is TasksAction.SetFlaggedOnly, TasksAction.ClearFilters,
            -> reshape(action)
            TasksAction.Retry -> load(silent = false)
            TasksAction.Refresh -> load(silent = true)
            is TasksAction.ToggleDone -> toggleDone(action.taskId)
            is TasksAction.Rename -> rename(action.taskId, singleLineTitle(action.title))
            is TasksAction.Add -> add(singleLineTitle(action.title))
            is TasksAction.OpenDetails -> emit(TasksEffect.OpenDetails(action.taskId))
            TasksAction.DismissNotice -> update { it.copy(notice = null) }
        }
    }

    private fun reshape(action: TasksAction) {
        update { shaped(it.after(action, catalog.projects)) }
    }

    private fun shaped(next: TasksState): TasksState = next.shaped(loaded, catalog, today())

    private fun load(silent: Boolean) {
        loadJob?.cancel()
        if (!silent) update { it.copy(phase = TasksPhase.LOADING, failure = null) }
        val tab = state.value.tab
        loadJob = viewModelScope.launch {
            val result = try {
                fetch(tab)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }
            ensureActive()
            when (result) {
                is RepositoryResult.Failure -> update {
                    if (silent) {
                        it.copy(notice = result.kind)
                    } else {
                        it.copy(phase = TasksPhase.ERROR, failure = result.kind)
                    }
                }
                is RepositoryResult.Content -> {
                    loaded = result.value
                    update { shaped(it.copy(phase = TasksPhase.CONTENT, failure = null)) }
                }
            }
        }
    }

    private suspend fun fetch(tab: TasksTab): RepositoryResult<List<WorkItem>> {
        val known = catalog.areas.isNotEmpty() || catalog.projects.isNotEmpty()
        val prepared = if (known) RepositoryResult.Content(catalog) else loadCatalog()
        return prepared.then { ready ->
            catalog = ready
            dependencies.tasks.tasks(tab.scope())
        }
    }

    private suspend fun loadCatalog(): RepositoryResult<TasksCatalog> =
        dependencies.catalog.areas().then { areas ->
            dependencies.catalog.projects().map { projects -> TasksCatalog(areas, projects) }
        }

    private fun toggleDone(taskId: String) {
        val task = loaded.firstOrNull { it.id == taskId } ?: return
        val done = task.status != TaskStatus.DONE
        write(task, ItemChange.Done(done), reload = true) {
            it.copy(status = if (done) TaskStatus.DONE else TaskStatus.NOT_DONE)
        }
    }

    private fun rename(taskId: String, title: String) {
        val task = loaded.firstOrNull { it.id == taskId } ?: return
        if (title.isEmpty() || title == task.title) return
        write(task, ItemChange.Title(title), reload = false) { it.copy(title = title) }
    }

    private fun write(task: WorkItem, change: ItemChange, reload: Boolean, optimistic: (WorkItem) -> WorkItem) {
        replace(optimistic(task))
        viewModelScope.launch {
            val result = writes.withLock {
                val current = loaded.firstOrNull { it.id == task.id } ?: return@withLock null
                try {
                    dependencies.items.update(current, change)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    RepositoryResult.Failure(FailureKind.UNAVAILABLE)
                }
            }
            ensureActive()
            when (result) {
                null -> Unit
                is RepositoryResult.Failure -> {
                    replace(task)
                    update { it.copy(notice = result.kind) }
                }
                is RepositoryResult.Content -> {
                    replace(result.value)
                    if (reload) load(silent = true)
                }
            }
        }
    }

    private fun add(title: String) {
        if (title.isEmpty()) return
        val state = state.value
        val draft = NewTask(title, today(), state.projectId)
        viewModelScope.launch {
            val result = try {
                dependencies.tasks.create(draft)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }
            ensureActive()
            when (result) {
                is RepositoryResult.Failure -> update { it.copy(notice = result.kind) }
                is RepositoryResult.Content -> load(silent = true)
            }
        }
    }

    private fun replace(task: WorkItem) {
        loaded = loaded.map { if (it.id == task.id) task else it }
        update { shaped(it) }
    }
}

private fun TasksTab.scope(): TaskScope = when (this) {
    TasksTab.TODAY -> TaskScope.TODAY
    TasksTab.PLANNED -> TaskScope.PLANNED
    TasksTab.ALL -> TaskScope.ALL
}
