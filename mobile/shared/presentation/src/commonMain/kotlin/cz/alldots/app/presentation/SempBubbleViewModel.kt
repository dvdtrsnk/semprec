package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.CountSempApprovals
import cz.alldots.app.domain.ListSempThreads
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempThreadKind
import cz.alldots.app.domain.SempThreadsQuery
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/** What the bubble tells the person after an object was dropped on it. */
enum class SempBubbleToast { ADDED, ALREADY_ADDED, CANNOT_ADD, NEW_THREAD, CONTINUE_THREAD }

/** [badge] is the number of requests waiting for the person's decision; [attachments] counts what is staged. */
data class SempBubbleState(
    val badge: Int = 0,
    val attachments: Int = 0,
    val toast: SempBubbleToast? = null,
)

sealed interface SempBubbleAction {
    /** Reads the number of waiting requests again, for a screen that comes to the front. */
    data object Refresh : SempBubbleAction

    /** An object was let go over the bubble. */
    data class Drop(val target: SempTarget) : SempBubbleAction
}

sealed interface SempBubbleEffect {
    /** The dropped Inbox item gets a thread of its own, which the chat opens on. */
    data class OpenItemThread(val inboxItemId: String, val title: String, val meta: String?) : SempBubbleEffect
}

private const val TOAST_MILLIS = 2_600L

/**
 * The floating bubble of Semp: how many requests wait for a decision, what is staged for the next message, and what
 * happens to an object dropped on it. An Inbox item opens its own thread; any other object that Semp can read is
 * staged for the next message of the main chat.
 */
class SempBubbleViewModel internal constructor(
    private val session: SempSession,
    private val count: CountSempApprovals,
    private val threads: ListSempThreads,
) : ScreenViewModel<SempBubbleState, SempBubbleAction, SempBubbleEffect>(SempBubbleState()) {
    private var toastJob: Job? = null

    init {
        session.attachments.onEach { staged -> update { it.copy(attachments = staged.size) } }.launchIn(viewModelScope)
        refresh()
    }

    override fun onAction(action: SempBubbleAction) {
        if (isClosed) return
        when (action) {
            SempBubbleAction.Refresh -> refresh()
            is SempBubbleAction.Drop -> drop(action.target)
        }
    }

    private fun refresh() {
        viewModelScope.launch {
            val result = guarded { count() }
            currentCoroutineContext().ensureActive()
            (result as? RepositoryResult.Content)?.let { content -> update { it.copy(badge = content.value) } }
        }
    }

    private fun drop(target: SempTarget) {
        if (target.kind == SempTargetKind.INBOX) {
            val inboxItemId = target.itemId ?: return show(SempBubbleToast.CANNOT_ADD)
            dropInbox(inboxItemId, target)
        } else {
            show(
                when (session.stage(target)) {
                    SempStaging.ADDED -> SempBubbleToast.ADDED
                    SempStaging.DUPLICATE -> SempBubbleToast.ALREADY_ADDED
                    SempStaging.UNSENDABLE -> SempBubbleToast.CANNOT_ADD
                },
            )
        }
    }

    private fun dropInbox(inboxItemId: String, target: SempTarget) {
        viewModelScope.launch {
            val query = SempThreadsQuery(setOf(SempThreadKind.ITEM), limit = 1, subjectInboxItemId = inboxItemId)
            val existing = (guarded { threads(query) } as? RepositoryResult.Content)?.value?.rows?.isNotEmpty() == true
            currentCoroutineContext().ensureActive()
            show(if (existing) SempBubbleToast.CONTINUE_THREAD else SempBubbleToast.NEW_THREAD)
            emit(SempBubbleEffect.OpenItemThread(inboxItemId, target.title, target.meta))
        }
    }

    private fun show(toast: SempBubbleToast) {
        toastJob?.cancel()
        update { it.copy(toast = toast) }
        toastJob = viewModelScope.launch {
            delay(TOAST_MILLIS)
            update { it.copy(toast = null) }
        }
    }
}
