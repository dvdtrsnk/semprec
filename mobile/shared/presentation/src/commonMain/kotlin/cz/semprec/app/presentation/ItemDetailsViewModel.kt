package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.domain.CatalogRepository
import cz.semprec.app.domain.Choices
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.ScheduleRules
import cz.semprec.app.domain.WorkItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the Podrobnosti sheet is made of: one item, the catalogs it picks from, and the signal to the open lists. */
internal class ItemDetailsDependencies(
    val items: ItemRepository,
    val catalog: CatalogRepository,
    val changes: ItemChanges,
)

/**
 * The Podrobnosti sheet of one task or event. Every edit shows at once and is written in turn, each naming the version
 * the one before it produced; a write that fails shows a notice and loads the item again, so that the sheet shows what
 * the server holds. Text typed into a field arrives only when it is committed.
 */
class ItemDetailsViewModel internal constructor(
    private val kind: ItemKind,
    private val itemId: String,
    private val dependencies: ItemDetailsDependencies,
) : ScreenViewModel<ItemDetailsState, ItemDetailsAction, ItemDetailsEffect>(ItemDetailsState(kind = kind)) {
    private var item: WorkItem? = null
    private var choices: Choices? = null
    private var loadJob: Job? = null
    private var choicesJob: Job? = null
    private val writes = Mutex()
    private var pendingWrites = 0

    init {
        load(silent = false)
    }

    override fun onAction(action: ItemDetailsAction) {
        if (isClosed) return
        when (action) {
            ItemDetailsAction.Retry -> load(silent = false)
            ItemDetailsAction.DismissNotice -> update { it.copy(notice = null) }
            ItemDetailsAction.LoadChoices -> loadChoices()
            ItemDetailsAction.Delete -> delete()
            is ItemDetailsAction.SetTitle, ItemDetailsAction.ToggleDone, is ItemDetailsAction.SetDescription,
            is ItemDetailsAction.SetPlace, is ItemDetailsAction.SetFlagged, is ItemDetailsAction.SetDate,
            is ItemDetailsAction.SetTimed, is ItemDetailsAction.SetEnded, is ItemDetailsAction.SetTimeFrom,
            is ItemDetailsAction.SetTimeTo, is ItemDetailsAction.SetAllDay, is ItemDetailsAction.SetRepeat,
            is ItemDetailsAction.SelectProject, is ItemDetailsAction.TogglePerson, is ItemDetailsAction.RemoveFile,
            is ItemDetailsAction.Unlink, is ItemDetailsAction.Relink,
            -> edit(action)
        }
    }

    private fun edit(action: ItemDetailsAction) {
        val current = item ?: return
        ItemDetailsChanges.of(action, current)?.let { write(current, it) }
    }

    private fun load(silent: Boolean) {
        loadJob?.cancel()
        if (!silent) update { it.copy(phase = ItemDetailsPhase.LOADING, failure = null) }
        loadJob = viewModelScope.launch {
            val result = try {
                // The item's own id, once a write stored an occurrence of a series under one.
                dependencies.items.load(kind, item?.id ?: itemId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }
            ensureActive()
            when (result) {
                is RepositoryResult.Failure -> update {
                    if (silent) {
                        it.copy(notice = it.notice ?: result.kind)
                    } else {
                        it.copy(phase = ItemDetailsPhase.ERROR, failure = result.kind)
                    }
                }
                is RepositoryResult.Content -> {
                    item = result.value
                    publish()
                }
            }
        }
    }

    private fun write(current: WorkItem, change: ItemChange) {
        item = current.applied(change)
        publish()
        pendingWrites += 1
        viewModelScope.launch {
            // The answer is applied before the next write starts, so that the next write names the version of this one.
            writes.withLock {
                val result = try {
                    dependencies.items.update(item ?: current, change)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    RepositoryResult.Failure(FailureKind.UNAVAILABLE)
                }
                ensureActive()
                pendingWrites -= 1
                when (result) {
                    is RepositoryResult.Content -> accept(result.value)
                    is RepositoryResult.Failure -> {
                        update { it.copy(notice = result.kind) }
                        load(silent = true)
                    }
                }
            }
        }
    }

    /** The item as the server holds it after a write; edits still waiting keep what they show and take the version. */
    private fun accept(written: WorkItem) {
        val latest = item
        item = if (pendingWrites == 0 || latest == null) written else latest.copy(version = written.version)
        publish()
        dependencies.changes.announce()
    }

    private fun delete() {
        val current = item ?: return
        viewModelScope.launch {
            val result = try {
                dependencies.items.delete(current.kind, current.id)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> {
                    dependencies.changes.announce()
                    emit(ItemDetailsEffect.Deleted)
                }
                is RepositoryResult.Failure -> update { it.copy(notice = result.kind) }
            }
        }
    }

    private fun loadChoices() {
        if (choicesJob?.isActive == true || choices != null) return
        update { it.copy(choices = ChoicesPhase.LOADING) }
        choicesJob = viewModelScope.launch {
            val found = try {
                val projects = dependencies.catalog.projects()
                val people = dependencies.catalog.people()
                if (projects is RepositoryResult.Content && people is RepositoryResult.Content) {
                    RepositoryResult.Content(Choices(projects.value, people.value))
                } else {
                    RepositoryResult.Failure((projects as? RepositoryResult.Failure)?.kind ?: FailureKind.UNAVAILABLE)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }
            ensureActive()
            when (found) {
                is RepositoryResult.Content -> choices = found.value
                is RepositoryResult.Failure -> Unit
            }
            publish(choicesFailed = found is RepositoryResult.Failure)
        }
    }

    private fun publish(choicesFailed: Boolean = false) {
        val current = item ?: return
        val picked = choices
        update { previous ->
            current.toState(previous).copy(
                choices = when {
                    picked != null -> ChoicesPhase.READY
                    choicesFailed -> ChoicesPhase.ERROR
                    else -> previous.choices
                },
                projectChoices = picked?.projects.orEmpty(),
                personChoices = picked?.people.orEmpty(),
            )
        }
    }
}

/** [this] as it looks while the write of [change] is on its way. */
private fun WorkItem.applied(change: ItemChange): WorkItem = when (change) {
    is ItemChange.Title -> copy(title = change.text)
    is ItemChange.Done -> copy(status = if (change.done) TaskStatus.DONE else TaskStatus.NOT_DONE)
    is ItemChange.Description -> copy(description = change.text)
    is ItemChange.Place -> copy(place = change.text)
    is ItemChange.Flagged -> copy(flagged = change.flagged)
    is ItemChange.Reschedule -> copy(schedule = change.schedule)
    is ItemChange.Repeat -> copy(repeat = change.repeat)
    else -> this
}

private fun WorkItem.toState(previous: ItemDetailsState): ItemDetailsState {
    val schedule: Schedule = schedule
    return previous.copy(
        phase = ItemDetailsPhase.CONTENT,
        failure = null,
        kind = kind,
        title = title,
        done = status == TaskStatus.DONE,
        description = description,
        place = place,
        flagged = flagged,
        date = schedule.date,
        endDate = schedule.endDate,
        timeFrom = schedule.timeFrom,
        timeTo = schedule.timeTo,
        allDay = kind == ItemKind.EVENT && schedule.timeFrom == null,
        lengthMinutes = ScheduleRules.lengthMinutes(schedule),
        repeat = repeat,
        project = project,
        people = people,
        files = files,
        hostEvents = hostEvents,
        company = company,
        projectLink = projectLink,
        peopleLink = peopleLink,
    )
}
