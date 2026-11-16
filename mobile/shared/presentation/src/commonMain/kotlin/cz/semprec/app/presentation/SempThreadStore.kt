package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.LoadOlderSempMessages
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempConversation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val FAST_POLL_MILLIS = 1_500L
private const val SLOW_POLL_MILLIS = 5_000L
private const val FAST_POLLS = 40
private const val MAX_POLLS = 160

/** What a chat screen holds and how it shows it: every change is a copy of [data], published as state. */
internal class SempThreadStore(
    val scope: CoroutineScope,
    initial: SempThreadData,
    private val publish: (SempThreadState) -> Unit,
) {
    var data: SempThreadData = initial
        private set

    /** Applies [transform] to what the screen is made of and shows the result. */
    fun change(transform: SempThreadData.() -> SempThreadData) {
        data = data.transform()
        publish(data.render())
    }
}

/** Reads the thread, again and again while a reply is awaited, and the older messages on request. */
internal class SempThreadLoader(
    private val store: SempThreadStore,
    private val reader: SempThreadReader,
    private val olderMessages: LoadOlderSempMessages,
) {
    private var pollJob: Job? = null
    private var olderJob: Job? = null

    fun stopPolling() {
        pollJob?.cancel()
    }

    suspend fun notice() {
        val summary = reader.notice()
        currentCoroutineContext().ensureActive()
        store.change { copy(summary = summary) }
    }

    /** Takes a conversation just read as the newest state of the thread, and asks again if a reply is awaited. */
    suspend fun adopt(conversation: SempConversation) {
        val approvals = reader.approvals(conversation.messages, store.data.approvals)
        currentCoroutineContext().ensureActive()
        store.change {
            copy(
                phase = SempThreadPhase.READY,
                failure = null,
                type = conversation.thread.kind.toType(),
                thread = conversation.thread,
                tickRunning = conversation.thread.activeRunId != null,
                newest = conversation.messages,
                olderCursor = if (older.isEmpty()) conversation.olderCursor else olderCursor,
                approvals = approvals,
            )
        }
        ensurePolling()
    }

    suspend fun reload(threadId: String) {
        val opened = reader.read(threadId)
        currentCoroutineContext().ensureActive()
        if (opened is SempOpened.Found) adopt(opened.conversation)
    }

    fun refreshNow() {
        val id = store.data.threadId ?: return
        store.scope.launch { reload(id) }
    }

    fun ensurePolling() {
        if (pollJob?.isActive == true || !store.data.awaitsReply) return
        pollJob = store.scope.launch {
            var polls = 0
            while (store.data.awaitsReply && polls < MAX_POLLS) {
                delay(if (polls < FAST_POLLS) FAST_POLL_MILLIS else SLOW_POLL_MILLIS)
                polls++
                store.data.threadId?.let { reload(it) }
            }
        }
    }

    fun loadOlder() {
        val threadId = store.data.threadId
        val cursor = store.data.olderCursor
        if (threadId == null || cursor == null || olderJob?.isActive == true) return
        store.change { copy(loadingOlder = true) }
        olderJob = store.scope.launch {
            val result = guarded { olderMessages(threadId, cursor) }
            currentCoroutineContext().ensureActive()
            store.change {
                when (result) {
                    is RepositoryResult.Content -> copy(
                        older = older + result.value.rows,
                        olderCursor = result.value.nextCursor,
                        loadingOlder = false,
                    )
                    else -> copy(loadingOlder = false)
                }
            }
        }
    }
}

internal fun SempThreadData.failedAction(kind: FailureKind?): SempThreadData =
    copy(actionFailed = true, actionFailure = kind)
