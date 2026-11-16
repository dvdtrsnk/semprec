package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.EditSempProjectAgent
import cz.semprec.app.domain.RegenerateSempReply
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.RetrySempReply
import cz.semprec.app.domain.SempSendRequest
import cz.semprec.app.domain.SendSempMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * What goes from the chat to the server: a message of the person, asking for a reply again, and running an automatic
 * task now. A message is a local entry first; it stays "sending" until the server has it and is read back, and it is
 * "failed" with a retry when the server did not take it.
 */
internal class SempThreadSender(
    private val store: SempThreadStore,
    private val loader: SempThreadLoader,
    private val session: SempSession,
    private val inboxItemId: String?,
    private val cases: SempSendCases,
) {
    private var counter = 0
    private val jobs = mutableMapOf<String, Job>()

    fun send(text: String) {
        val data = store.data
        if (text.isBlank() || data.locals.any { it.delivery == SempDelivery.SENDING }) return
        val attachments = if (data.type == SempThreadType.CHAT) data.attachments else emptyList()
        val keys = attachments.map { it.key }.toSet()
        val local = SempLocalMessage(
            id = "local-${counter++}",
            text = text.trim(),
            attachments = attachments,
            refs = session.refs().filter { "${it.kind}:${it.id}" in keys },
            delivery = SempDelivery.SENDING,
            failure = null,
        )
        store.change { copy(locals = locals + local) }
        deliver(local)
    }

    fun deliver(local: SempLocalMessage) {
        store.change {
            copy(locals = locals.map { if (it.id == local.id) it.copy(delivery = SempDelivery.SENDING) else it })
        }
        jobs[local.id]?.cancel()
        jobs[local.id] = store.scope.launch {
            val threadId = store.data.threadId
            val request = SempSendRequest(
                threadId = threadId,
                subjectInboxItemId = inboxItemId.takeIf { threadId == null },
                text = local.text,
                context = local.refs,
            )
            val result = guarded { cases.send(request) }
            currentCoroutineContext().ensureActive()
            when (result) {
                is RepositoryResult.Content -> delivered(local, result.value.threadId)
                is RepositoryResult.Failure -> failed(local, result.kind)
                null -> failed(local, null)
            }
        }
    }

    private suspend fun delivered(local: SempLocalMessage, threadId: String) {
        session.unstage(local.attachments.map { it.key }.toSet())
        loader.reload(threadId)
        store.change { copy(locals = locals.filterNot { it.id == local.id }) }
        loader.ensurePolling()
    }

    private fun failed(local: SempLocalMessage, kind: FailureKind?) = store.change {
        copy(
            locals = locals.map {
                if (it.id == local.id) it.copy(delivery = SempDelivery.FAILED, failure = kind) else it
            },
        )
    }

    fun resolveUnsent(id: String, retry: Boolean) {
        val local = store.data.locals.firstOrNull { it.id == id } ?: return
        if (retry) deliver(local) else store.change { copy(locals = locals.filterNot { it.id == id }) }
    }

    /** Retries the failed reply [messageId], or writes the answer again. */
    fun reply(messageId: String, regenerate: Boolean) {
        val threadId = store.data.threadId ?: return
        store.scope.launch {
            val result = guarded {
                if (regenerate) cases.regenerate(threadId, messageId) else cases.retry(threadId, messageId)
            }
            currentCoroutineContext().ensureActive()
            when (result) {
                is RepositoryResult.Content -> loader.reload(threadId)
                is RepositoryResult.Failure -> store.change { failedAction(result.kind) }
                null -> store.change { failedAction(null) }
            }
        }
    }

    /** Runs the automatic task of a tick thread now, and watches for its run. */
    fun runAgain() {
        val tick = store.data.thread?.tick ?: return
        if (!tick.canTrigger || store.data.tickRunning) return
        store.change { copy(triggerFailed = false, tickRunning = true) }
        store.scope.launch {
            val result = guarded { cases.agent.runTask(tick.heartbeatId) }
            currentCoroutineContext().ensureActive()
            if (result is RepositoryResult.Content) {
                loader.ensurePolling()
            } else {
                store.change { copy(tickRunning = false, triggerFailed = true) }
            }
        }
    }
}

/** The writes a chat makes. */
internal class SempSendCases(
    val send: SendSempMessage,
    val retry: RetrySempReply,
    val regenerate: RegenerateSempReply,
    val agent: EditSempProjectAgent,
)
