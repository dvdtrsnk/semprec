package cz.alldots.app.data

import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.domain.SyncTopic
import cz.alldots.app.domain.note.PageChanges
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.http.HttpMethod
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlin.random.Random

private const val SYNC_PATH = "/api/sync"
private const val RECONNECT_BASE_DELAY_MILLIS = 1_000L
private const val RECONNECT_MAX_DELAY_MILLIS = 30_000L
// The first attempt whose ceiling, 1 s doubled per attempt, passes the 30 s cap.
private const val RECONNECT_CAPPED_ATTEMPT = 5
// Frames that arrive within this time of each other raise their topics once.
private const val FRAME_COALESCE_MILLIS = 300L

/**
 * The reconnect delay of `WS /api/sync` before attempt [attempt] (0 after the first drop): its ceiling doubles from
 * 1 s per attempt up to 30 s, and the delay is jittered between the 1 s floor and that ceiling, so clients dropped by
 * the same fault do not come back at once. The web client waits the same.
 */
internal fun nextReconnectDelayMillis(attempt: Int, random: () -> Double): Long {
    val ceiling = if (attempt >= RECONNECT_CAPPED_ATTEMPT) {
        RECONNECT_MAX_DELAY_MILLIS
    } else {
        minOf(RECONNECT_MAX_DELAY_MILLIS, RECONNECT_BASE_DELAY_MILLIS shl attempt)
    }
    return RECONNECT_BASE_DELAY_MILLIS + (random() * (ceiling - RECONNECT_BASE_DELAY_MILLIS)).toLong()
}

/**
 * The one authenticated `WS /api/sync` connection of a window. The server sends thin frames that name what changed;
 * this socket turns those that concern a [SyncTopic] into a raise of [changes], and the screens read the data again
 * over REST. It goes out with the session of [api], as every request of the window does.
 *
 * After a drop it reconnects with [nextReconnectDelayMillis]. Each successful connect raises every topic once,
 * because the server does not replay what it published while the socket was away. A socket whose session the
 * server refused, by closing it as revoked or by refusing the handshake with `401`, does not reconnect
 * ([AuthenticatedApi.openSocket] signs the window out), and nor does one started while nobody is signed in. [start] and [stop] are called on one thread, the main thread of the app.
 *
 * With [offline], every connect and every text frame tells the offline layer that what it keeps may have changed
 * (docs/adr/2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind.md). A frame that a page changed raises its item
 * on [pages], so an open note reads it again
 * (docs/adr/2026-11-23-note-edits-merge-three-ways-and-wait-on-the-device.md).
 */
class SyncSocket internal constructor(
    private val api: AuthenticatedApi,
    private val changes: SyncChanges,
    private val scope: CoroutineScope,
    private val reconnectDelay: (attempt: Int) -> Long,
    private val coalesceMillis: Long,
    private val offline: OfflineLayer? = null,
    private val pages: PageChanges = PageChanges(),
) {
    constructor(
        api: AuthenticatedApi,
        changes: SyncChanges,
        scope: CoroutineScope,
        offline: OfflineLayer? = null,
        pages: PageChanges = PageChanges(),
    ) : this(
        api,
        changes,
        scope,
        { attempt -> nextReconnectDelayMillis(attempt, Random::nextDouble) },
        FRAME_COALESCE_MILLIS,
        offline,
        pages,
    )

    private var job: Job? = null

    /** Connects, and stays connected until [stop]; does nothing while it already runs. */
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch { run() }
    }

    /** Closes the socket with a normal close frame; no reconnect follows until the next [start]. */
    fun stop() {
        job?.cancel()
        job = null
    }

    private suspend fun run() {
        var attempt = 0
        while (true) {
            api.openSocket(SYNC_PATH) { session ->
                attempt = 0
                listen(session)
            } ?: return
            delay(reconnectDelay(attempt))
            attempt += 1
        }
    }

    private suspend fun listen(session: DefaultClientWebSocketSession) = coroutineScope {
        offline?.connected()
        val databases = databaseKeys()
        changes.raise(SyncTopic.entries.toSet())
        val raised = Channel<Set<SyncTopic>>(Channel.UNLIMITED)
        launch {
            for (first in raised) {
                delay(coalesceMillis)
                val topics = first.toMutableSet()
                while (true) topics += raised.tryReceive().getOrNull() ?: break
                changes.raise(topics)
            }
        }
        try {
            for (frame in session.incoming) {
                if (frame !is Frame.Text) continue
                offline?.frameArrived()
                val parsed = parseSyncFrame(frame.readText())
                if (parsed is SyncFrame.PageChanged) pages.changed(parsed.itemId)
                val topics = parsed?.topics(databases).orEmpty()
                if (topics.isNotEmpty()) raised.trySend(topics)
            }
        } finally {
            raised.close()
        }
    }

    /** The canonical key of every database of the tenant by its id, or `null` when the schema cannot be read. */
    private suspend fun databaseKeys(): Map<String, String>? =
        when (val schema = api.send(HttpMethod.Get, "/api/schema").decode<SyncSchema>()) {
            is RepositoryResult.Failure -> null
            is RepositoryResult.Content ->
                schema.value.databases
                    .mapNotNull { database -> database.key?.let { database.databaseId to it } }
                    .toMap()
        }
}

@Serializable
private data class SyncSchema(val databases: List<SyncSchemaDatabase>)

@Serializable
private data class SyncSchemaDatabase(val databaseId: String, val key: String? = null)
