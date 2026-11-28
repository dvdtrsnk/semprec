package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CountSempApprovals
import cz.alldots.app.domain.ListSempApprovals
import cz.alldots.app.domain.ListSempThreads
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempPreview
import cz.alldots.app.domain.SempThreadKind
import cz.alldots.app.domain.SempThreadRow
import cz.alldots.app.domain.SempThreadsQuery
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

enum class SempChatsPhase { LOADING, READY, ERROR }

/** Which threads the history lists: everything, the person's own chats (with the Inbox item threads), or the tasks. */
enum class SempChatsFilter { ALL, CHATS, TICKS }

/** One thread of the history. A chat the server has not titled yet has no [title]; the preview stands in for it. */
data class SempChatRow(
    val id: String,
    val type: SempThreadType,
    val title: String?,
    val previewText: String?,
    val previewSystemKey: String?,
    val lastActivityAt: String,
    val waiting: Boolean,
    val projectName: String?,
    val subjectInboxItemId: String?,
)

data class SempChatsState(
    val phase: SempChatsPhase = SempChatsPhase.LOADING,
    val failure: FailureKind? = null,
    val query: String = "",
    val filter: SempChatsFilter = SempChatsFilter.ALL,
    val rows: List<SempChatRow> = emptyList(),
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val approvals: List<SempApprovalItem> = emptyList(),
    val approvalCount: Int = 0,
)

sealed interface SempChatsAction {
    data object Retry : SempChatsAction

    data class SetQuery(val text: String) : SempChatsAction

    data class SetFilter(val filter: SempChatsFilter) : SempChatsAction

    data object LoadMore : SempChatsAction

    data class Decide(val approvalId: String, val approve: Boolean) : SempChatsAction

    data class OpenThread(val threadId: String) : SempChatsAction

    data object OpenApprovals : SempChatsAction

    data object OpenNewChat : SempChatsAction
}

sealed interface SempChatsEffect {
    data class OpenThread(val row: SempChatRow) : SempChatsEffect

    data object OpenApprovals : SempChatsEffect

    data object OpenNewChat : SempChatsEffect
}

private const val DEBOUNCE_MILLIS = 300L
private const val SHOWN_APPROVALS = 3

/** What the history reads. */
internal class SempChatsReads(
    val threads: ListSempThreads,
    val approvals: ListSempApprovals,
    val count: CountSempApprovals
)

/**
 * The history of chats and automatic-task threads, searched and filtered by the server, and the approval requests of
 * the chats that wait for a decision, which can be decided here.
 */
class SempChatsViewModel internal constructor(
    private val reads: SempChatsReads,
    private val approvalFlow: SempApprovalFlow,
) : ScreenViewModel<SempChatsState, SempChatsAction, SempChatsEffect>(SempChatsState()) {
    private var loadJob: Job? = null
    private var moreJob: Job? = null
    private var cursor: String? = null
    private val decisions = mutableMapOf<String, Job>()

    init {
        load(wait = false)
    }

    override fun onAction(action: SempChatsAction) {
        if (isClosed) return
        when (action) {
            SempChatsAction.Retry -> load(wait = false)
            is SempChatsAction.SetQuery -> {
                update { it.copy(query = action.text) }
                load(wait = true)
            }
            is SempChatsAction.SetFilter -> {
                update { it.copy(filter = action.filter) }
                load(wait = false)
            }
            SempChatsAction.LoadMore -> loadMore()
            is SempChatsAction.Decide -> decide(action.approvalId, action.approve)
            is SempChatsAction.OpenThread ->
                state.value.rows.firstOrNull { it.id == action.threadId }?.let { emit(SempChatsEffect.OpenThread(it)) }
            SempChatsAction.OpenApprovals -> emit(SempChatsEffect.OpenApprovals)
            SempChatsAction.OpenNewChat -> emit(SempChatsEffect.OpenNewChat)
        }
    }

    private fun query(from: String?): SempThreadsQuery = SempThreadsQuery(
        kinds = when (state.value.filter) {
            SempChatsFilter.ALL -> setOf(SempThreadKind.CHAT, SempThreadKind.ITEM, SempThreadKind.TICK)
            SempChatsFilter.CHATS -> setOf(SempThreadKind.CHAT, SempThreadKind.ITEM)
            SempChatsFilter.TICKS -> setOf(SempThreadKind.TICK)
        },
        search = state.value.query,
        cursor = from,
    )

    private fun load(wait: Boolean) {
        loadJob?.cancel()
        moreJob?.cancel()
        update {
            it.copy(
                phase = if (it.phase == SempChatsPhase.READY) it.phase else SempChatsPhase.LOADING,
                failure = null,
                loadingMore = false,
            )
        }
        loadJob = viewModelScope.launch {
            if (wait) delay(DEBOUNCE_MILLIS)
            val threads = guarded { reads.threads(query(null)) }
            val approvals = guarded { reads.approvals(true, null) }
            val count = guarded { reads.count() }
            currentCoroutineContext().ensureActive()
            when (threads) {
                is RepositoryResult.Content -> {
                    cursor = threads.value.nextCursor
                    update {
                        it.copy(
                            phase = SempChatsPhase.READY,
                            rows = threads.value.rows.map { row -> row.toChatRow() },
                            hasMore = cursor != null,
                            approvals = (approvals as? RepositoryResult.Content)?.value?.rows.orEmpty()
                                .take(SHOWN_APPROVALS).map { approval -> approval.toItem() },
                            approvalCount = (count as? RepositoryResult.Content)?.value ?: 0,
                        )
                    }
                }
                is RepositoryResult.Failure -> update { it.copy(phase = SempChatsPhase.ERROR, failure = threads.kind) }
                null -> update { it.copy(phase = SempChatsPhase.ERROR, failure = null) }
            }
        }
    }

    private fun loadMore() {
        val next = cursor ?: return
        if (moreJob?.isActive == true || state.value.phase != SempChatsPhase.READY) return
        update { it.copy(loadingMore = true) }
        moreJob = viewModelScope.launch {
            val result = guarded { reads.threads(query(next)) }
            currentCoroutineContext().ensureActive()
            if (result is RepositoryResult.Content) {
                cursor = result.value.nextCursor
                update {
                    it.copy(rows = it.rows + result.value.rows.map { row -> row.toChatRow() }, hasMore = cursor != null)
                }
            }
            update { it.copy(loadingMore = false) }
        }
    }

    private fun decide(approvalId: String, approve: Boolean) {
        if (state.value.approvals.none { it.id == approvalId } || decisions[approvalId]?.isActive == true) return
        decisions[approvalId] = viewModelScope.launch {
            approvalFlow.run(approvalId, approve) { change ->
                update { current ->
                    current.copy(
                        approvals = current.approvals.map { if (it.id == approvalId) it.after(change) else it },
                    )
                }
            }
            val settled = state.value.approvals.firstOrNull { it.id == approvalId }?.decision
            if (settled != SempDecisionState.PENDING) load(wait = false)
        }
    }
}

private fun SempThreadRow.toChatRow() = SempChatRow(
    id = id,
    type = kind.toType(),
    title = title,
    previewText = preview?.text,
    previewSystemKey = preview?.let(SempPreview::systemKey),
    lastActivityAt = lastActivityAt,
    waiting = hasPendingApproval,
    projectName = projectName,
    subjectInboxItemId = subjectInboxItemId,
)
