package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.StoredSession
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** How long a write made while others wait, and the server can be reached, waits for its own answer. */
internal val QUEUED_WRITE_WAIT: Duration = 10.seconds

/** A queued write the server answers with a server error or a throttle this often is dropped. */
internal const val MAX_QUEUED_WRITE_ATTEMPTS = 8

private const val RETRY_BASE_MILLIS = 1_000L
private const val RETRY_MAX_MILLIS = 60_000L
private const val RETRY_CAPPED_ATTEMPT = 6
private const val UNAUTHORIZED_STATUS = 401
private const val NOT_FOUND_STATUS = 404
private const val CONFLICT_STATUS = 409
private const val NO_CONTENT_STATUS = 204
private const val IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"

/**
 * Sends what the device keeps with the session signed in now: [session] is that session and [account] names it, both
 * `null` when there is none; [send] sends a request and [upload] sends [RawBody] as the raw body of a `POST`.
 */
internal interface QueueSender {
    fun account(): String?

    fun session(): StoredSession?

    suspend fun send(request: ApiRequest): ApiResponse

    suspend fun upload(path: String, body: RawBody): ApiResponse
}

/** How many writes wait for the server and which the server refused, for the account signed in. */
internal data class QueueStatus(val waiting: Int, val failures: List<QueuedWriteFailure>)

/**
 * The time a queued write is stamped with, the jitter of its retries and the device's day queued writes are shown
 * against; tests fix all three.
 */
internal class QueueClock(val now: () -> String, val random: () -> Double, val today: () -> String)

/**
 * The delay before the next replay after the [attempt]-th that the server could not act on (0 after the first): its
 * ceiling doubles from 1 s up to 60 s, and the delay is jittered between the 1 s floor and that ceiling.
 */
internal fun nextReplayDelayMillis(attempt: Int, random: () -> Double): Long {
    val doubled = if (attempt >= RETRY_CAPPED_ATTEMPT) RETRY_MAX_MILLIS else RETRY_BASE_MILLIS shl attempt
    val ceiling = minOf(RETRY_MAX_MILLIS, doubled)
    return RETRY_BASE_MILLIS + (random() * (ceiling - RETRY_BASE_MILLIS)).toLong()
}

/**
 * The writes of the offline set made without a connection
 * (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection.md). With nothing queued and the
 * process not offline, a write is sent directly, and it waits in the account's queue ([KeptQueue]) only when it gets
 * no answer, a `5xx` or a `429`. While the process is offline a write is queued at once; while other writes wait, it
 * is queued behind them and its caller waits up to [QUEUED_WRITE_WAIT] for its own answer. A write that waits answers
 * what [QueuedAnswers] makes up. [replayer] sends the queue.
 */
internal class OfflineWrites(
    private val store: OfflineStore,
    private val scope: CoroutineScope,
    private val state: LayerState,
    private val clock: QueueClock,
    private val newId: () -> String,
) {
    private val waiters = QueueWaiters()
    private val mutableStatus = MutableStateFlow(QueueStatus(0, emptyList()))
    private val replayer = QueueReplayer(store, scope, state, waiters, clock) { mutableStatus.value = it.status() }

    /** The queue of the account signed in, as it changes. */
    val status: StateFlow<QueueStatus> = mutableStatus.asStateFlow()

    /**
     * Runs after every replay that finished, whatever started it: the note pages wait for the ids the queue maps, and
     * the warm-up reads what the replay wrote.
     */
    var afterReplay: suspend () -> Unit
        get() = replayer.afterRun
        set(value) {
            replayer.afterRun = value
        }

    /** The sender of the window attached last, which sends what the device keeps; `null` before any attached. */
    fun sender(): QueueSender? = replayer.current()

    /** The window's [sender] sends what is queued from now on; whatever waits is replayed. */
    fun attach(sender: QueueSender) {
        replayer.sender(sender)
        replaySoon()
    }

    /** Sends or queues [request], a write of [route] made with [session]; [transmit] sends it to the server. */
    suspend fun write(
        session: StoredSession,
        route: QueuedRoute,
        request: ApiRequest,
        transmit: suspend (ApiRequest) -> ApiResponse,
    ): ApiResponse {
        val account = accountKey(session)
        val made = if (route.createsId) newId() else null
        val prepared = request.withIdempotencyKey(route, made)
        val queued = store.queue.state(account)
        val offline = state.locked { state.connectivity.offline }
        return when {
            queued == null -> transmit(prepared)
            queued.writes.isNotEmpty() || offline -> enqueue(account, route, prepared, made, wait = !offline)
            else -> sendDirectly(account, route, prepared, made, transmit)
        }
    }

    /** Replays the queue now, or once more after the replay under way; [afterReplay] runs when it finished. */
    fun replaySoon() {
        scope.launch { replayer.run() }
    }

    /** Forgets the failures recorded for the account signed in. */
    suspend fun forgetFailures() {
        val account = replayer.account() ?: return
        store.queue.forgetFailures(account)?.let { mutableStatus.value = it.status() }
    }

    /** The store forgot every queue: nothing waits and nothing failed any more. */
    fun cleared() {
        mutableStatus.value = QueueStatus(0, emptyList())
    }

    private suspend fun sendDirectly(
        account: String,
        route: QueuedRoute,
        request: ApiRequest,
        made: String?,
        transmit: suspend (ApiRequest) -> ApiResponse,
    ): ApiResponse {
        val response = transmit(request)
        state.answered(response)
        if (response.waitsInQueue()) return enqueue(account, route, request, made, wait = false)
        if (response is ApiResponse.Success) state.locked { state.freshness.wrote() }
        return response
    }

    private suspend fun enqueue(
        account: String,
        route: QueuedRoute,
        request: ApiRequest,
        made: String?,
        wait: Boolean,
    ): ApiResponse {
        val write = QueuedWrite.of(newId(), request, made, clock.now())
        val waiter = if (wait) waiters.register(write.id) else null
        val appended = store.queue.append(account, write)
        if (appended != null) {
            mutableStatus.value = appended.status()
            replaySoon()
        }
        val answered = if (appended != null && waiter != null) {
            withTimeoutOrNull(QUEUED_WRITE_WAIT) { waiter.await() }
        } else {
            null
        }
        waiters.remove(write.id)
        return when {
            appended == null -> ApiResponse.Failure(FailureKind.UNAUTHORIZED, null)
            answered != null -> answered
            else -> madeUp(account, route, request, made, write.queuedAt)
        }
    }

    private suspend fun madeUp(
        account: String,
        route: QueuedRoute,
        request: ApiRequest,
        made: String?,
        queuedAt: String,
    ): ApiResponse {
        val kept = QueuedAnswers.lookups(route, request).mapNotNull { id ->
            store.answers.newestObject(account, id)?.let { id to it }
        }.toMap()
        return QueuedAnswers.answer(route, request, made, queuedAt, kept)
    }
}

/** The write being replayed, the account whose queue holds it and the sender that sends it. */
private class Replaying(val account: String, val write: QueuedWrite, val sender: QueueSender)

/**
 * Sends the queue of the account signed in, one write at a time and in order, for the whole process: [run] while a
 * run is under way only asks it to run once more. Before a write is sent, every id the device made that the server
 * has answered is replaced by the server's id in its path, query and body; a write naming an id whose write was
 * dropped is dropped too. Each answer is decided by [replayOutcome]; every outcome that changes the queue makes the
 * kept answers stale and tells every window, and a write that could not be acted on is retried after
 * [nextReplayDelayMillis]. When the replay stops before the queue is empty, every caller that waits gets its made-up
 * answer at once.
 */
@OptIn(ExperimentalAtomicApi::class)
internal class QueueReplayer(
    private val store: OfflineStore,
    private val scope: CoroutineScope,
    private val state: LayerState,
    private val waiters: QueueWaiters,
    private val clock: QueueClock,
    private val publish: (QueueState) -> Unit,
) {
    private val running = Mutex()
    private val again = AtomicBoolean(false)
    private val sender = AtomicReference<QueueSender?>(null)
    private val retry = AtomicReference<Job?>(null)

    fun sender(next: QueueSender) {
        sender.store(next)
    }

    fun account(): String? = sender.load()?.account()

    fun current(): QueueSender? = sender.load()

    /** Runs after every [run] that replayed, once its replay finished; a [run] that found one under way leaves it. */
    var afterRun: suspend () -> Unit = {}

    /**
     * Replays until the queue is empty, the server cannot act on the first write or nobody is signed in, then runs
     * [afterRun]. While a replay is under way it only asks that one to run once more, and that one runs [afterRun].
     */
    suspend fun run() {
        again.store(true)
        var replayed = false
        while (again.load() && running.tryLock()) {
            try {
                while (again.compareAndSet(expectedValue = true, newValue = false)) replayAll()
                replayed = true
            } finally {
                running.unlock()
            }
        }
        if (replayed) afterRun()
    }

    private suspend fun replayAll() {
        val sender = sender.load() ?: return
        val account = sender.account() ?: return
        var goesOn = true
        while (goesOn) goesOn = step(account, sender)
    }

    /** Replays the first write of the queue of [account]; whether another one may follow. */
    private suspend fun step(account: String, sender: QueueSender): Boolean {
        val queued = store.queue.state(account)?.also(publish)
        val write = queued?.writes?.firstOrNull()
        val failed = write?.let { queued.droppedNamedBy(it) }
        return when {
            queued == null || write == null -> false
            failed != null -> drop(Replaying(account, write, sender), failed, null)
            else -> {
                val request = write.toRequest().resolved(queued.ids)
                val goesOn = settle(Replaying(account, write, sender), request, sender.send(request), retried = false)
                if (!goesOn) waiters.releaseAll()
                goesOn
            }
        }
    }

    private suspend fun settle(
        replaying: Replaying,
        request: ApiRequest,
        response: ApiResponse,
        retried: Boolean,
    ): Boolean {
        state.answered(response)
        val write = replaying.write
        return when (val outcome = replayOutcome(request, response, retried)) {
            is ReplayOutcome.Done -> {
                val serverId = write.newId?.let { createdId(request, outcome.answer.body) }
                store.queue.complete(replaying.account, write, serverId)?.let(publish)
                waiters.complete(write.id, outcome.answer)
                state.changed()
                true
            }
            ReplayOutcome.Unanswered -> false.also { retryLater(write.attempts) }
            ReplayOutcome.ServerError -> if (write.attempts + 1 >= MAX_QUEUED_WRITE_ATTEMPTS) {
                drop(replaying, FailureKind.UNAVAILABLE, response)
            } else {
                store.queue.attempted(replaying.account, write)?.let(publish)
                false.also { retryLater(write.attempts + 1) }
            }
            ReplayOutcome.SessionRefused -> false
            ReplayOutcome.StaleVersion -> retryWithVersion(replaying, request)
            is ReplayOutcome.Refused -> drop(replaying, outcome.kind, response)
        }
    }

    /** Reads the item of a `PATCH` refused as stale and sends the change once more against its current version. */
    private suspend fun retryWithVersion(replaying: Replaying, request: ApiRequest): Boolean {
        val current = replaying.sender.send(ApiRequest(HttpMethod.Get, request.path))
        val version = (current as? ApiResponse.Success)?.let { versionOf(it.body) }
        val body = version?.let { request.body?.let { text -> withVersion(text, it) } }
            ?: return drop(replaying, FailureKind.REJECTED, null)
        val resent = request.copy(body = body)
        return settle(replaying, resent, replaying.sender.send(resent), retried = true)
    }

    /** Drops the write with a failure of [kind]; its caller, if it still waits, gets [response]. Always goes on. */
    private suspend fun drop(replaying: Replaying, kind: FailureKind, response: ApiResponse?): Boolean {
        val write = replaying.write
        val route = QueuedRoute.of(HttpMethod.parse(write.method), write.path)?.template ?: write.method
        store.queue.drop(replaying.account, write, QueuedWriteFailure(route, kind, clock.now()))?.let(publish)
        waiters.complete(write.id, response ?: ApiResponse.Failure(kind, null))
        state.changed()
        return true
    }

    private fun retryLater(attempt: Int) {
        val next = scope.launch {
            delay(nextReplayDelayMillis(attempt, clock.random))
            run()
        }
        retry.exchange(next)?.cancel()
    }
}

/** What an answer to a queued write does to it. */
internal sealed interface ReplayOutcome {
    /** The server acted on it (or a deleted item was gone already); [answer] is what its caller gets. */
    data class Done(val answer: ApiResponse.Success) : ReplayOutcome

    /** No answer: it stays and is sent again later. */
    data object Unanswered : ReplayOutcome

    /** A server error or a throttle: it stays, counted, until it is dropped after [MAX_QUEUED_WRITE_ATTEMPTS]. */
    data object ServerError : ReplayOutcome

    /** The session was refused: nothing more is sent; the window forgets the session, and the queue with it. */
    data object SessionRefused : ReplayOutcome

    /** A `PATCH` against a version the item no longer has. */
    data object StaleVersion : ReplayOutcome

    /** The server refused it: it is dropped. */
    data class Refused(val kind: FailureKind) : ReplayOutcome
}

/** The outcome of [response] to the queued [request]; [retried] tells that a stale version was already read again. */
internal fun replayOutcome(request: ApiRequest, response: ApiResponse, retried: Boolean): ReplayOutcome = when {
    response is ApiResponse.Success -> ReplayOutcome.Done(response)
    response !is ApiResponse.Failure -> ReplayOutcome.Refused(FailureKind.INVALID_DATA)
    response.status == null -> ReplayOutcome.Unanswered
    response.kind == FailureKind.UNAVAILABLE -> ReplayOutcome.ServerError
    response.status == UNAUTHORIZED_STATUS -> ReplayOutcome.SessionRefused
    response.status == NOT_FOUND_STATUS && request.method == HttpMethod.Delete ->
        ReplayOutcome.Done(ApiResponse.Success(NO_CONTENT_STATUS, ""))
    response.status == CONFLICT_STATUS && !retried && request.isVersionedPatch() -> ReplayOutcome.StaleVersion
    else -> ReplayOutcome.Refused(response.kind)
}

/** The callers that wait for the answer to their queued write, by write id. */
internal class QueueWaiters {
    private val lock = Mutex()
    private val waiting = HashMap<String, CompletableDeferred<ApiResponse?>>()

    suspend fun register(id: String): CompletableDeferred<ApiResponse?> =
        CompletableDeferred<ApiResponse?>().also { lock.withLock { waiting[id] = it } }

    suspend fun complete(id: String, response: ApiResponse) {
        lock.withLock { waiting.remove(id) }?.complete(response)
    }

    suspend fun remove(id: String) {
        lock.withLock { waiting.remove(id) }
    }

    /** The replay stopped: every caller gets the answer made up for it at once instead of waiting on. */
    suspend fun releaseAll() {
        val released = lock.withLock { waiting.values.toList().also { waiting.clear() } }
        released.forEach { it.complete(null) }
    }
}

private fun QueueState.status() = QueueStatus(writes.size, failures)

/** Whether [this] answer means the write waits in the queue: no answer, a server error or a throttle. */
private fun ApiResponse.waitsInQueue(): Boolean =
    this is ApiResponse.Failure && (status == null || kind == FailureKind.UNAVAILABLE)

/** A create without an `Idempotency-Key` gets [made] as its key, so a repeat after a lost answer creates nothing. */
private fun ApiRequest.withIdempotencyKey(route: QueuedRoute, made: String?): ApiRequest {
    val keyed = extraHeaders.any { (name, _) -> name.equals(IDEMPOTENCY_KEY_HEADER, ignoreCase = true) }
    if (route != QueuedRoute.CREATE_ITEM || made == null || keyed) return this
    return copy(extraHeaders = extraHeaders + (IDEMPOTENCY_KEY_HEADER to made))
}
