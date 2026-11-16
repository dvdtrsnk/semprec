package cz.semprec.app.domain

/** The Semp chats of the signed-in person: the history, a thread, its messages, sending, retrying, regenerating. */
interface SempRepository {
    suspend fun threads(query: SempThreadsQuery): RepositoryResult<SempThreadsPage>

    suspend fun thread(threadId: String): RepositoryResult<SempThread>

    /** The messages of a thread, newest first; [before] is the `nextCursor` of the page before. */
    suspend fun messages(threadId: String, before: String?): RepositoryResult<SempMessagesPage>

    /** Queues a message; the answer comes later and is read from [messages]. */
    suspend fun send(request: SempSendRequest): RepositoryResult<SempSendReceipt>

    /** Asks for the reply [messageId] (an assistant message that failed) to be made again. */
    suspend fun retry(threadId: String, messageId: String): RepositoryResult<Unit>

    /** Asks for the answer [messageId] to be written again. */
    suspend fun regenerate(threadId: String, messageId: String): RepositoryResult<Unit>
}
