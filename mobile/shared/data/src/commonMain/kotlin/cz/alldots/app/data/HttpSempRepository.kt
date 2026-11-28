package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempMessagesPage
import cz.alldots.app.domain.SempRepository
import cz.alldots.app.domain.SempSendReceipt
import cz.alldots.app.domain.SempSendRequest
import cz.alldots.app.domain.SempThread
import cz.alldots.app.domain.SempThreadsPage
import cz.alldots.app.domain.SempThreadsQuery
import cz.alldots.app.domain.map
import cz.alldots.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.encodeToString

private const val THREADS_PATH = "/api/semp/threads"
private const val MESSAGES_PAGE_SIZE = 50

/**
 * The Semp chats over the backend: `GET /api/semp/threads` for the history, the thread and its messages under
 * `/api/semp/threads/:id`, and `POST` to queue a message, retry a failed reply or write an answer again. A sent
 * message is answered with ids only; the reply is read later from the messages (the chat polls, the server does
 * not stream).
 */
class HttpSempRepository(private val api: AuthenticatedApi) : SempRepository {

    override suspend fun threads(query: SempThreadsQuery): RepositoryResult<SempThreadsPage> {
        val parameters = buildList {
            add("kind" to query.kinds.joinToString(",") { it.wire() })
            add("limit" to query.limit.toString())
            query.search?.let { add("q" to it) }
            query.cursor?.let { add("cursor" to it) }
            query.subjectInboxItemId?.let { add("subjectInboxItemId" to it) }
        }
        return api.send(HttpMethod.Get, THREADS_PATH, query = parameters).decode<SempThreadListDto>().map { list ->
            SempThreadsPage(list.rows.mapNotNull { it.toDomain() }, list.nextCursor)
        }
    }

    override suspend fun thread(threadId: String): RepositoryResult<SempThread> =
        api.send(HttpMethod.Get, "$THREADS_PATH/$threadId").decode<SempThreadDetailDto>().then { dto ->
            dto.toDomain()?.let { RepositoryResult.Content(it) } ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }

    override suspend fun messages(threadId: String, before: String?): RepositoryResult<SempMessagesPage> {
        val parameters = buildList {
            add("limit" to MESSAGES_PAGE_SIZE.toString())
            before?.let { add("before" to it) }
        }
        return api.send(HttpMethod.Get, "$THREADS_PATH/$threadId/messages", query = parameters)
            .decode<SempMessageListDto>()
            .map { list -> SempMessagesPage(list.rows.mapNotNull { it.toDomain() }, list.nextCursor) }
    }

    override suspend fun send(request: SempSendRequest): RepositoryResult<SempSendReceipt> {
        val context = request.context.mapNotNull { it.toBody() }
        val body = SempSendBodyDto(
            text = request.text,
            context = context.takeIf { it.isNotEmpty() },
            subject = request.subjectInboxItemId?.let(::SempSendSubjectDto),
        )
        val path = request.threadId?.let { "$THREADS_PATH/$it/messages" } ?: THREADS_PATH
        return api.send(HttpMethod.Post, path, body = ApiJson.encodeToString(body)).decode<SempSendReceiptDto>()
            .map { SempSendReceipt(it.threadId, it.messageId, it.assistantMessageId) }
    }

    override suspend fun retry(threadId: String, messageId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "$THREADS_PATH/$threadId/messages/$messageId/retry").ignoreBody()

    override suspend fun regenerate(threadId: String, messageId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "$THREADS_PATH/$threadId/messages/$messageId/regenerate").ignoreBody()
}
