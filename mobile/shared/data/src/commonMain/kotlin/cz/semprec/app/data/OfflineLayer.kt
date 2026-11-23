package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.StoredSession
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.ExperimentalTime
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/** How long a kept answer counts as fresh at most, even when nothing signalled a change. */
internal val KEPT_ANSWER_FRESH_FOR: Duration = 5.minutes

/** How often, at most, a request checks in the background whether the server can be reached again. */
internal val OFFLINE_PROBE_EVERY: Duration = 15.seconds

private const val NOT_FOUND_STATUS = 404

/** One request as [AuthenticatedApi.send] got it, without the session it goes out with. */
internal data class ApiRequest(
    val method: HttpMethod,
    val path: String,
    val query: List<Pair<String, String>> = emptyList(),
    val body: String? = null,
    val extraHeaders: List<Pair<String, String>> = emptyList(),
    val bodyContentType: ContentType = ContentType.Application.Json,
    val requestTimeoutMillis: Long? = null,
) {
    /** The key a kept answer is found by: the method, the path, the query in the order sent and the body. */
    fun key(): String = JsonArray(
        listOf(
            JsonPrimitive(method.value),
            JsonPrimitive(path),
            JsonArray(query.map { (name, value) -> JsonArray(listOf(JsonPrimitive(name), JsonPrimitive(value))) }),
            body?.let(::JsonPrimitive) ?: JsonNull,
        ),
    ).toString()
}

/**
 * Answers the reads of the offline set ([OfflineRoutes]) from what the device keeps in [store], keeps what the server
 * answers (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md), and queues the writes of the offline
 * set made without a connection ([writes], docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-
 * connection.md). Every window of the process shares the layer of its directory ([shared]); [AuthenticatedApi] hands
 * it each such request.
 *
 * A kept answer is fresh when this process kept it after the last change signal and less than
 * [KEPT_ANSWER_FRESH_FOR] ago; a fresh answer is returned without a request. The change signals are a write that
 * succeeded ([wrote]), the sync socket connecting ([connected]), every frame it receives ([frameArrived]) and every
 * queued write that reached the server or was dropped. Any other read goes out: a success is kept and returned, `404`
 * removes the kept answer, and a request that got no answer, a `5xx` or a `429` returns the kept answer when there is
 * one.
 *
 * A request that got no answer makes the process offline until a request gets one or the socket connects. Offline,
 * a read with a kept answer returns it at once, and at most once every [OFFLINE_PROBE_EVERY] one of them goes out in
 * [scope] to check the connection. When an answer ends the offline state, every kept answer turns stale, [changes]
 * emits, so the screens of every window read again, and the queue is replayed.
 */
class OfflineLayer internal constructor(
    internal val store: OfflineStore,
    private val scope: CoroutineScope,
    timeSource: TimeSource = TimeSource.Monotonic,
    clock: QueueClock = QueueClock(::currentInstant, Random::nextDouble, ::localToday),
    newId: () -> String = ::randomId,
) {
    private val state = LayerState(timeSource)
    internal val writes = OfflineWrites(store, scope, state, clock, newId)
    private val views = QueuedViews(store, clock.today)

    /** The note pages read and written through the device. */
    val pages = OfflinePages(store, state) { writes.sender() }

    init {
        writes.afterReplay = pages::writeWaiting
    }

    /** Emits when what the screens of every window show may have changed. */
    val changes: Flow<Unit> = state.changes

    /**
     * Answers [request], a read of the offline set made with [session]; [transmit] sends it to the server. Every id
     * the device made that the server answered is replaced by the server's id first, and the writes still queued are
     * applied to the answer ([QueuedViews]).
     */
    internal suspend fun read(
        session: StoredSession,
        request: ApiRequest,
        transmit: suspend (ApiRequest) -> ApiResponse,
    ): ApiResponse {
        val account = accountKey(session)
        val queued = store.queue.state(account)
        val resolved = queued?.let { request.resolved(it.ids) } ?: request
        return views.project(account, resolved, answer(account, resolved, transmit), queued)
    }

    private suspend fun answer(
        account: String,
        request: ApiRequest,
        transmit: suspend (ApiRequest) -> ApiResponse,
    ): ApiResponse {
        val key = request.key()
        val kept = store.answers.answer(account, key)
        val served = kept?.let {
            state.locked {
                when {
                    state.connectivity.offline -> Served(probe = state.connectivity.probeDue())
                    state.freshness.isFresh(account, key) -> Served(probe = false)
                    else -> null
                }
            }
        }
        if (kept != null && served != null) {
            if (served.probe) probe(account, key, request, transmit)
            return kept.toResponse()
        }
        val sentAt = state.locked { state.freshness.signal }
        return settle(account, key, transmit(request), kept, sentAt)
    }

    /** Sends or queues [request], a write of [route] made with [session]; [transmit] sends it to the server. */
    internal suspend fun write(
        session: StoredSession,
        route: QueuedRoute,
        request: ApiRequest,
        transmit: suspend (ApiRequest) -> ApiResponse,
    ): ApiResponse = writes.write(session, route, request, transmit)

    /** A request outside the offline set got [response]; whether any answer came tells whether the server is reached. */
    internal suspend fun observed(response: ApiResponse) {
        state.answered(response)
    }

    /** A write of a window succeeded; the window announces it itself, so nothing is emitted. */
    internal suspend fun wrote() {
        state.locked {
            state.freshness.changed()
            state.connectivity.offline = false
        }
    }

    /** The sync socket of a window connected: the server is reached, what it sent meanwhile is unknown. */
    internal suspend fun connected() {
        state.connected()
        writes.replaySoon()
    }

    /** The sync socket of a window received a frame: something the server keeps changed. */
    internal suspend fun frameArrived() {
        state.locked { state.freshness.changed() }
    }

    /** Removes everything kept, the queue included, as the session ended. */
    suspend fun clear() {
        store.clear()
        state.locked { state.freshness.clear() }
    }

    private suspend fun settle(
        account: String,
        key: String,
        response: ApiResponse,
        kept: KeptAnswer?,
        sentAt: Long,
    ): ApiResponse = when (response) {
        is ApiResponse.Success -> {
            store.answers.keep(account, key, KeptAnswer(response.status, response.body, response.etag))
            state.locked { state.freshness.kept(account, key, sentAt) }
            state.reached()
            response
        }
        is ApiResponse.Failure -> when {
            response.status == null -> {
                state.answered(response)
                kept?.toResponse() ?: response
            }
            response.kind == FailureKind.UNAVAILABLE -> {
                state.reached()
                kept?.toResponse() ?: response
            }
            response.status == NOT_FOUND_STATUS -> {
                store.answers.forget(account, key)
                state.locked { state.freshness.forgot(account, key) }
                state.reached()
                response
            }
            else -> {
                state.reached()
                response
            }
        }
    }

    /** Sends [request] in [scope] to find out whether the server can be reached again. */
    private fun probe(
        account: String,
        key: String,
        request: ApiRequest,
        transmit: suspend (ApiRequest) -> ApiResponse,
    ) {
        scope.launch {
            try {
                val sentAt = state.locked { state.freshness.signal }
                settle(account, key, transmit(request), null, sentAt)
            } finally {
                withContext(NonCancellable) { state.locked { state.connectivity.probeEnded() } }
            }
        }
    }

    private class Served(val probe: Boolean)

    companion object {
        @OptIn(ExperimentalAtomicApi::class)
        private val layers = AtomicReference<Map<String, OfflineLayer>>(emptyMap())

        /**
         * The layer of [directory] for the whole process: every window that keeps its data there shares it, so they
         * share one store, one freshness, one offline state and one queue. Its background work runs for as long as
         * the process.
         */
        @OptIn(ExperimentalAtomicApi::class)
        fun shared(directory: String): OfflineLayer {
            while (true) {
                val current = layers.load()
                current[directory]?.let { return it }
                val layer = OfflineLayer(OfflineStore(directory), CoroutineScope(SupervisorJob() + Dispatchers.Default))
                if (layers.compareAndSet(current, current + (directory to layer))) return layer
            }
        }
    }
}

/**
 * What the reads and the writes of [OfflineLayer] share: the freshness of the kept answers, whether the process is
 * offline, and the flow that tells the windows. [freshness] and [connectivity] are used inside [locked] only.
 * [onReachedAgain] runs when an answer or a connect ended the offline state.
 */
internal class LayerState(timeSource: TimeSource) {
    private val lock = Mutex()
    val freshness = Freshness(timeSource)
    val connectivity = Connectivity(timeSource)
    private val mutableChanges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val changes: Flow<Unit> = mutableChanges.asSharedFlow()
    var onReachedAgain: () -> Unit = {}

    suspend fun <T> locked(block: () -> T): T = lock.withLock { block() }

    /** Something every window shows changed: the kept answers turn stale and the windows are told. */
    suspend fun changed() {
        locked { freshness.changed() }
        mutableChanges.tryEmit(Unit)
    }

    /** A request got [response]: without an answer the process is offline, with one an offline state ends. */
    suspend fun answered(response: ApiResponse) {
        if (response is ApiResponse.Failure && response.status == null) {
            locked { connectivity.offline = true }
        } else {
            reached()
        }
    }

    /** The server answered: an offline state ends, the kept answers turn stale and the windows are told. */
    suspend fun reached() {
        val ended = locked {
            val wasOffline = connectivity.offline
            if (wasOffline) {
                connectivity.offline = false
                freshness.changed()
            }
            wasOffline
        }
        if (ended) {
            mutableChanges.tryEmit(Unit)
            onReachedAgain()
        }
    }

    /** A socket connected: the kept answers turn stale; an offline state ends and the windows are told. */
    suspend fun connected() {
        val wasOffline = locked {
            freshness.changed()
            connectivity.offline.also { connectivity.offline = false }
        }
        if (wasOffline) mutableChanges.tryEmit(Unit)
    }
}

/**
 * When each answer of this process was kept: the change signal its request went out after and the time it arrived.
 * An answer is fresh while no change signal followed and [KEPT_ANSWER_FRESH_FOR] has not passed.
 */
internal class Freshness(private val timeSource: TimeSource) {
    var signal = 0L
        private set
    private val kept = HashMap<String, Pair<Long, TimeMark>>()

    fun changed() {
        signal += 1
    }

    fun kept(account: String, key: String, sentAt: Long) {
        kept[freshnessKey(account, key)] = sentAt to timeSource.markNow()
    }

    fun forgot(account: String, key: String) {
        kept.remove(freshnessKey(account, key))
    }

    fun isFresh(account: String, key: String): Boolean {
        val (sentAt, keptAt) = kept[freshnessKey(account, key)] ?: return false
        return sentAt == signal && keptAt.elapsedNow() < KEPT_ANSWER_FRESH_FOR
    }

    fun clear() {
        kept.clear()
    }

    private fun freshnessKey(account: String, key: String) = "$account\n$key"
}

/** Whether the process is offline, and when the last probe went out. */
internal class Connectivity(private val timeSource: TimeSource) {
    var offline = false
    private var lastProbe: TimeMark? = null
    private var probing = false

    /** Whether a probe may go out now; marks it as going out. */
    fun probeDue(): Boolean {
        val last = lastProbe
        if (probing || (last != null && last.elapsedNow() < OFFLINE_PROBE_EVERY)) return false
        probing = true
        lastProbe = timeSource.markNow()
        return true
    }

    fun probeEnded() {
        probing = false
    }
}

@OptIn(ExperimentalTime::class)
private fun currentInstant(): String = Clock.System.now().toString()

@OptIn(ExperimentalUuidApi::class)
private fun randomId(): String = Uuid.random().toString()
