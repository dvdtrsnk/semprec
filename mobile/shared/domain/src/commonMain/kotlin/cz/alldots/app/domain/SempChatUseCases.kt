package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/** A thread with the messages a person sees, oldest first, and where the older ones continue. */
data class SempConversation(val thread: SempThread, val messages: List<SempMessage>, val olderCursor: String?)

/** The most messages of one message that a send may refer to. */
const val SEMP_MAX_CONTEXT = 20

/** Reads a thread and its newest messages. A thread whose id is blank is invalid data. */
class LoadSempConversation(private val repository: SempRepository) {
    suspend operator fun invoke(threadId: String): RepositoryResult<SempConversation> {
        if (threadId.isBlank()) return RepositoryResult.Failure(FailureKind.INVALID_DATA)
        return repository.thread(threadId).then { thread ->
            repository.messages(threadId, null).map { page ->
                SempConversation(thread, SempTimeline.visible(page.rows), page.nextCursor)
            }
        }
    }
}

/** Reads the newest messages again, to see how a queued reply came out. */
class RefreshSempMessages(private val repository: SempRepository) {
    suspend operator fun invoke(threadId: String): RepositoryResult<SempMessagesPage> =
        repository.messages(threadId, null)
}

/** Reads the page of messages before [cursor]. */
class LoadOlderSempMessages(private val repository: SempRepository) {
    suspend operator fun invoke(threadId: String, cursor: String): RepositoryResult<SempMessagesPage> =
        repository.messages(threadId, cursor)
}

/**
 * Sends the text. Text that is only blanks is never sent, and a message names at most [SEMP_MAX_CONTEXT] objects,
 * which is what the server takes.
 */
class SendSempMessage(private val repository: SempRepository) {
    suspend operator fun invoke(request: SempSendRequest): RepositoryResult<SempSendReceipt> {
        val text = request.text.trim()
        if (text.isEmpty() || request.context.size > SEMP_MAX_CONTEXT) {
            return RepositoryResult.Failure(FailureKind.REJECTED)
        }
        return repository.send(request.copy(text = text))
    }
}

class RetrySempReply(private val repository: SempRepository) {
    suspend operator fun invoke(threadId: String, messageId: String): RepositoryResult<Unit> =
        repository.retry(threadId, messageId)
}

class RegenerateSempReply(private val repository: SempRepository) {
    suspend operator fun invoke(threadId: String, messageId: String): RepositoryResult<Unit> =
        repository.regenerate(threadId, messageId)
}

/** The history of chats, filtered and searched by the server. */
class ListSempThreads(private val repository: SempRepository) {
    suspend operator fun invoke(query: SempThreadsQuery): RepositoryResult<SempThreadsPage> =
        repository.threads(query.copy(search = query.search?.trim()?.takeIf { it.isNotEmpty() }))
}
