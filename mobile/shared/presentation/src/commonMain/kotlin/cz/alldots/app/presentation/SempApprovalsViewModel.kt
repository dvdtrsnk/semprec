package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CountSempApprovals
import cz.alldots.app.domain.ListSempApprovals
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

enum class SempApprovalsPhase { LOADING, READY, ERROR }

enum class SempApprovalsTab { PENDING, DECIDED }

data class SempApprovalsState(
    val phase: SempApprovalsPhase = SempApprovalsPhase.LOADING,
    val failure: FailureKind? = null,
    val tab: SempApprovalsTab = SempApprovalsTab.PENDING,
    val items: List<SempApprovalItem> = emptyList(),
    val pendingCount: Int = 0,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val expanded: Set<String> = emptySet(),
)

sealed interface SempApprovalsAction {
    data object Retry : SempApprovalsAction

    data class SetTab(val tab: SempApprovalsTab) : SempApprovalsAction

    data object LoadMore : SempApprovalsAction

    data class Decide(val approvalId: String, val approve: Boolean) : SempApprovalsAction

    data class ToggleDetails(val approvalId: String) : SempApprovalsAction

    data class OpenThread(val approvalId: String) : SempApprovalsAction

    data class OpenRun(val approvalId: String) : SempApprovalsAction
}

sealed interface SempApprovalsEffect {
    data class OpenThread(val threadId: String) : SempApprovalsEffect

    data class OpenRun(val runId: String) : SempApprovalsEffect
}

/**
 * The queue of approval requests: those that wait for a decision and those that were decided. A request is approved
 * or rejected here, and an approved one is followed until the server has carried it out. A decided request stays in
 * the waiting list, with how it came out, until the person leaves the tab.
 */
class SempApprovalsViewModel internal constructor(
    private val list: ListSempApprovals,
    private val count: CountSempApprovals,
    private val approvalFlow: SempApprovalFlow,
) : ScreenViewModel<SempApprovalsState, SempApprovalsAction, SempApprovalsEffect>(SempApprovalsState()) {
    private var loadJob: Job? = null
    private var moreJob: Job? = null
    private var cursor: String? = null
    private val decisions = mutableMapOf<String, Job>()

    init {
        load()
    }

    override fun onAction(action: SempApprovalsAction) {
        if (isClosed) return
        when (action) {
            SempApprovalsAction.Retry -> load()
            is SempApprovalsAction.SetTab -> if (action.tab != state.value.tab) {
                update { it.copy(tab = action.tab, phase = SempApprovalsPhase.LOADING, items = emptyList()) }
                load()
            }
            SempApprovalsAction.LoadMore -> loadMore()
            is SempApprovalsAction.Decide -> decide(action.approvalId, action.approve)
            is SempApprovalsAction.ToggleDetails -> update {
                val open = action.approvalId in it.expanded
                it.copy(expanded = if (open) it.expanded - action.approvalId else it.expanded + action.approvalId)
            }
            is SempApprovalsAction.OpenThread ->
                item(action.approvalId)?.threadId?.let { emit(SempApprovalsEffect.OpenThread(it)) }
            is SempApprovalsAction.OpenRun ->
                item(action.approvalId)?.runId?.let { emit(SempApprovalsEffect.OpenRun(it)) }
        }
    }

    private fun item(id: String) = state.value.items.firstOrNull { it.id == id }

    private fun load() {
        loadJob?.cancel()
        moreJob?.cancel()
        update { it.copy(phase = SempApprovalsPhase.LOADING, failure = null, loadingMore = false) }
        loadJob = viewModelScope.launch {
            val page = guarded { list(state.value.tab == SempApprovalsTab.PENDING, null) }
            val pending = guarded { count() }
            currentCoroutineContext().ensureActive()
            when (page) {
                is RepositoryResult.Content -> {
                    cursor = page.value.nextCursor
                    update {
                        it.copy(
                            phase = SempApprovalsPhase.READY,
                            items = page.value.rows.map { row -> row.toItem() },
                            pendingCount = (pending as? RepositoryResult.Content)?.value ?: it.pendingCount,
                            hasMore = cursor != null,
                        )
                    }
                }
                is RepositoryResult.Failure -> update { it.copy(phase = SempApprovalsPhase.ERROR, failure = page.kind) }
                null -> update { it.copy(phase = SempApprovalsPhase.ERROR, failure = null) }
            }
        }
    }

    private fun loadMore() {
        val next = cursor ?: return
        if (moreJob?.isActive == true || state.value.phase != SempApprovalsPhase.READY) return
        update { it.copy(loadingMore = true) }
        moreJob = viewModelScope.launch {
            val result = guarded { list(state.value.tab == SempApprovalsTab.PENDING, next) }
            currentCoroutineContext().ensureActive()
            if (result is RepositoryResult.Content) {
                cursor = result.value.nextCursor
                val more = result.value.rows.map { row -> row.toItem() }
                update { it.copy(items = it.items + more, hasMore = cursor != null) }
            }
            update { it.copy(loadingMore = false) }
        }
    }

    private fun decide(approvalId: String, approve: Boolean) {
        if (item(approvalId) == null || decisions[approvalId]?.isActive == true) return
        decisions[approvalId] = viewModelScope.launch {
            approvalFlow.run(approvalId, approve) { change ->
                update { current ->
                    current.copy(items = current.items.map { if (it.id == approvalId) it.after(change) else it })
                }
            }
            val pending = guarded { count() }
            currentCoroutineContext().ensureActive()
            (pending as? RepositoryResult.Content)?.let { result -> update { it.copy(pendingCount = result.value) } }
        }
    }
}
