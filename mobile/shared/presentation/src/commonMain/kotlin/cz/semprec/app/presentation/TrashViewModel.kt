package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.AccountRestoreStatus
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AccountRestoreResult
import cz.semprec.app.domain.AccountTrashDatabase
import cz.semprec.app.domain.AccountTrashItem
import cz.semprec.app.domain.AccountTrashRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The trash: deleted items and deleted databases, restored one by one or several at once. Only the list of the open
 * tab is read; a restore reads it again. A refused id is counted in the [TrashEffect], not hidden.
 */
class TrashViewModel internal constructor(
    private val trash: AccountTrashRepository,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<TrashState, TrashAction, TrashEffect>(TrashState()) {
    private var loadJob: Job? = null
    private var cursor: String? = null

    init {
        reloadOnChanges(changes) { load(state.value.tab) }
        load(TrashTab.ITEMS)
    }

    override fun onAction(action: TrashAction) {
        if (isClosed) return
        when (action) {
            TrashAction.Retry -> load(state.value.tab)
            is TrashAction.SelectTab -> if (action.tab != state.value.tab) load(action.tab)
            TrashAction.LoadMore -> loadMore()
            TrashAction.ToggleSelecting -> update { it.copy(selecting = !it.selecting, selected = emptyList()) }
            is TrashAction.Toggle -> toggle(action.id)
            TrashAction.SelectAll -> update { it.copy(selected = it.ids()) }
            is TrashAction.Restore -> restore(listOf(action.id))
            TrashAction.RestoreSelected -> restore(state.value.selected)
            TrashAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun toggle(id: String) {
        update { current ->
            when {
                id !in current.ids() -> current
                id in current.selected -> current.copy(selected = current.selected - id)
                else -> current.copy(selected = current.selected + id)
            }
        }
    }

    private fun load(tab: TrashTab) {
        loadJob?.cancel()
        cursor = null
        update { TrashState(tab = tab) }
        loadJob = viewModelScope.launch {
            when (tab) {
                TrashTab.ITEMS -> {
                    val result = answer { trash.items(null) }
                    ensureActive()
                    if (result is Answer.Done) cursor = result.value.nextCursor
                    update { current ->
                        when (result) {
                            is Answer.Rejected -> current.failed(result.kind)
                            is Answer.Done -> current.copy(
                                phase = TrashPhase.CONTENT,
                                items = result.value.items.map { it.toRow() },
                                totalItems = result.value.totalCount,
                                hasMore = result.value.nextCursor != null,
                            )
                        }
                    }
                }
                TrashTab.DATABASES -> {
                    val result = answer { trash.databases() }
                    ensureActive()
                    update { current ->
                        when (result) {
                            is Answer.Rejected -> current.failed(result.kind)
                            is Answer.Done ->
                                current.copy(phase = TrashPhase.CONTENT, databases = result.value.map { it.toRow() })
                        }
                    }
                }
            }
        }
    }

    private fun loadMore() {
        val next = cursor
        val current = state.value
        if (next == null || current.tab != TrashTab.ITEMS || current.loadingMore) return
        update { it.copy(loadingMore = true) }
        loadJob = viewModelScope.launch {
            val result = answer { trash.items(next) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Rejected -> it.copy(loadingMore = false, writeFailure = Failed(result.kind))
                    is Answer.Done -> {
                        cursor = result.value.nextCursor
                        it.copy(
                            loadingMore = false,
                            items = it.items + result.value.items.map { row -> row.toRow() },
                            hasMore = result.value.nextCursor != null,
                        )
                    }
                }
            }
        }
    }

    private fun restore(ids: List<String>) {
        val before = state.value
        val known = ids.filter { it in before.ids() }
        if (known.isEmpty() || before.working) return
        update { it.copy(working = true, writeFailure = null) }
        viewModelScope.launch {
            val result = answer {
                when (before.tab) {
                    TrashTab.ITEMS -> trash.restore(known, emptyList())
                    TrashTab.DATABASES -> trash.restore(emptyList(), known)
                }
            }
            ensureActive()
            when (result) {
                is Answer.Rejected -> update { it.copy(working = false, writeFailure = Failed(result.kind)) }
                is Answer.Done -> {
                    emit(result.value.toEffect(before))
                    load(before.tab)
                }
            }
        }
    }
}

private fun TrashState.ids(): List<String> = when (tab) {
    TrashTab.ITEMS -> items.map { it.id }
    TrashTab.DATABASES -> databases.map { it.id }
}

private fun List<AccountRestoreResult>.toEffect(before: TrashState): TrashEffect.Restored {
    val restored = filter { it.status == AccountRestoreStatus.RESTORED }
    val name = restored.singleOrNull()?.let { one -> before.items.firstOrNull { it.id == one.id }?.databaseName }
    return TrashEffect.Restored(restored.size, size - restored.size, name)
}

private fun TrashState.failed(kind: FailureKind?) = copy(phase = TrashPhase.ERROR, failure = kind)

private fun AccountTrashItem.toRow() = TrashItemRow(id, title, databaseKey, databaseName, deletedAt, daysLeft)

private fun AccountTrashDatabase.toRow() = TrashDatabaseRow(id, name, itemCount, archivedAt, daysLeft)
