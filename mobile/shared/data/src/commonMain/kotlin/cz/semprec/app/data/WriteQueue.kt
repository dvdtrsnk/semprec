package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val QUEUE = "queue.json"

/**
 * One write of the offline set that waits for the server: the request as the repository built it, the id made on the
 * device for what it creates ([newId], `null` when it creates nothing), how often it was sent without an answer the
 * server could act on, and when it was queued.
 */
@Serializable
internal data class QueuedWrite(
    val id: String,
    val method: String,
    val path: String,
    val query: List<List<String>> = emptyList(),
    val body: String? = null,
    val contentType: String? = null,
    val headers: List<List<String>> = emptyList(),
    val newId: String? = null,
    val attempts: Int = 0,
    val queuedAt: String,
) {
    fun toRequest(): ApiRequest = ApiRequest(
        method = HttpMethod.parse(method),
        path = path,
        query = query.mapNotNull { pair -> if (pair.size == 2) pair[0] to pair[1] else null },
        body = body,
        extraHeaders = headers.mapNotNull { pair -> if (pair.size == 2) pair[0] to pair[1] else null },
        bodyContentType = contentType?.let(ContentType::parse) ?: ContentType.Application.Json,
    )

    companion object {
        fun of(id: String, request: ApiRequest, newId: String?, queuedAt: String) = QueuedWrite(
            id = id,
            method = request.method.value,
            path = request.path,
            query = request.query.map { (name, value) -> listOf(name, value) },
            body = request.body,
            contentType = request.bodyContentType.toString(),
            headers = request.extraHeaders.map { (name, value) -> listOf(name, value) },
            newId = newId,
            queuedAt = queuedAt,
        )
    }
}

/** A queued write the server refused, without its ids or body: the route, why, and when it was dropped. */
@Serializable
internal data class QueuedWriteFailure(val route: String, val kind: FailureKind, val at: String)

/** What the queue of an account holds at one moment. */
internal data class QueueState(
    val writes: List<QueuedWrite>,
    /** Server id of each id made on the device whose write the server answered. */
    val ids: Map<String, String>,
    /** The ids made on the device whose write was dropped, with why it was dropped. */
    val dropped: Map<String, FailureKind>,
    val failures: List<QueuedWriteFailure>,
)

private val EMPTY_QUEUE = QueueState(emptyList(), emptyMap(), emptyMap(), emptyList())

/**
 * The queue of the account in `<account>/queue.json`: the waiting writes in the order they were made, the server ids
 * of the ids made on the device, the dropped ids and the failures. It is read once per account and written whole
 * after every change, so a reader finds the queue before a change or after it, never a part
 * (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection.md). A file that cannot be decoded,
 * or names another version or account, reads as an empty queue.
 */
internal class KeptQueue(private val store: OfflineStore) {
    private var held: QueueState? = null

    /** The queue of [account]; `null` when the account's session ended. */
    suspend fun state(account: String): QueueState? = store.using(account, keeping = false) { load(account) }

    /** Appends [write] at the end. */
    suspend fun append(account: String, write: QueuedWrite): QueueState? =
        change(account) { it.copy(writes = it.writes + write) }

    /**
     * Removes the answered [write]; [serverId] is the server's id of what it created. When a write that created
     * something gets an answer naming no id, the writes naming the id made for it are dropped as unreadable.
     */
    suspend fun complete(account: String, write: QueuedWrite, serverId: String?): QueueState? = change(account) {
        val made = write.newId
        it.copy(
            writes = it.writes.filterNot { queued -> queued.id == write.id },
            ids = if (made != null && serverId != null) it.ids + (made to serverId) else it.ids,
            dropped = if (made != null && serverId == null) {
                it.dropped + (made to FailureKind.INVALID_DATA)
            } else {
                it.dropped
            },
        )
    }

    /** Removes the refused [write] and records [failure]; what it would have created is dropped with it. */
    suspend fun drop(account: String, write: QueuedWrite, failure: QueuedWriteFailure): QueueState? =
        change(account) {
            val dropped = if (write.newId != null) it.dropped + (write.newId to failure.kind) else it.dropped
            it.copy(
                writes = it.writes.filterNot { queued -> queued.id == write.id },
                dropped = dropped,
                failures = it.failures + failure,
            )
        }

    /** Counts one more attempt of [write] that the server could not act on. */
    suspend fun attempted(account: String, write: QueuedWrite): QueueState? = change(account) { state ->
        state.copy(
            writes = state.writes.map { queued ->
                if (queued.id == write.id) queued.copy(attempts = queued.attempts + 1) else queued
            },
        )
    }

    /** Forgets the recorded failures. */
    suspend fun forgetFailures(account: String): QueueState? = change(account) { it.copy(failures = emptyList()) }

    /** Forgets what is held in memory; called by the store, with its lock held, when the account changes or ends. */
    fun reset() {
        held = null
    }

    /**
     * Applies [edit] in memory and writes the queue. A failed write leaves the file before it: the queue in memory goes
     * on, and after a restart a write the file still holds is sent again, which every queued route tolerates.
     */
    private suspend fun change(account: String, edit: (QueueState) -> QueueState): QueueState? =
        store.using(account, keeping = true) {
            val next = edit(load(account))
            held = next
            val file = QueueFile(OFFLINE_FILE_VERSION, account, next.writes, next.ids, next.dropped, next.failures)
            writeCacheFile(path(account), store.json.encodeToString(QueueFile.serializer(), file))
            next
        }

    private fun load(account: String): QueueState {
        held?.let { return it }
        val file = readCacheFile(path(account))?.let { text ->
            decodeQueueOrNull { store.json.decodeFromString(QueueFile.serializer(), text) }
        }
        val state = if (file != null && file.version == OFFLINE_FILE_VERSION && file.account == account) {
            QueueState(file.writes, file.ids, file.dropped, file.failures)
        } else {
            EMPTY_QUEUE
        }
        held = state
        return state
    }

    private fun path(account: String) = "${store.root}/$account/$QUEUE"
}

private inline fun <T> decodeQueueOrNull(decode: () -> T): T? = try {
    decode()
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

@Serializable
private data class QueueFile(
    val version: Int,
    val account: String,
    val writes: List<QueuedWrite> = emptyList(),
    val ids: Map<String, String> = emptyMap(),
    val dropped: Map<String, FailureKind> = emptyMap(),
    val failures: List<QueuedWriteFailure> = emptyList(),
)

/** Why a write naming an id made for a dropped write is dropped too: the failure of that write, or `null`. */
internal fun QueueState.droppedNamedBy(write: QueuedWrite): FailureKind? {
    val text = write.text()
    return dropped.entries.firstOrNull { (id, _) -> id in text }?.value
}

/** [this] request with every id of [ids] replaced by the server's id in its path, query and body. */
internal fun ApiRequest.resolved(ids: Map<String, String>): ApiRequest {
    if (ids.isEmpty()) return this
    fun String.swapped() = ids.entries.fold(this) { text, (local, server) -> text.replace(local, server) }
    return copy(
        path = path.swapped(),
        query = query.map { (name, value) -> name to value.swapped() },
        body = body?.swapped(),
    )
}

/** Whether [this] is a `PATCH /api/items/:id` that names the version it was made against. */
internal fun ApiRequest.isVersionedPatch(): Boolean =
    QueuedRoute.of(method, path) == QueuedRoute.PATCH_ITEM && parseObject(body)?.get("ifVersion") != null

/** The id the server gave what [request] created: `itemId` for a diary period's page, else `id`. */
internal fun createdId(request: ApiRequest, body: String): String? {
    val field = if (QueuedRoute.of(request.method, request.path) == QueuedRoute.PERIOD_PAGE) "itemId" else "id"
    return (parseObject(body)?.get(field) as? JsonPrimitive)?.takeIf { it.isString }?.content
}

/** The `version` of an item answer, or `null`. */
internal fun versionOf(body: String): String? =
    (parseObject(body)?.get("version") as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The JSON object [body] with `ifVersion` set to [version], or `null` when [body] is not one. */
internal fun withVersion(body: String, version: String): String? =
    parseObject(body)?.let { JsonObject(it + ("ifVersion" to JsonPrimitive(version))).toString() }

/** Everything of a queued write that can name an id made on the device. */
private fun QueuedWrite.text(): String = buildString {
    append(path)
    query.forEach { pair -> pair.forEach(::append) }
    append(body.orEmpty())
}

private fun parseObject(text: String?): JsonObject? = text?.let {
    decodeQueueOrNull { ApiJson.parseToJsonElement(it) as? JsonObject }
}
