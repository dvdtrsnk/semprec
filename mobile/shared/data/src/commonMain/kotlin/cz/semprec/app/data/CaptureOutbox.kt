package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.InboxCapture
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.util.hex
import io.ktor.util.sha1
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/** How long a capture the server refused waits before it is sent again. */
private val REFUSED_CAPTURE_WAIT: Duration = 1.hours

private const val UNAUTHORIZED_STATUS = 401
private const val IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
private const val TYPE_FIELD = "typeId"
private const val ATTACHMENTS_FIELD = "attachments"

/**
 * The Inbox captures that wait on the device for the server
 * (docs/adr/2026-11-27-inbox-captures-wait-in-a-device-outbox-that-outlives-the-session.md), one per process and data
 * directory, owned by [OfflineLayer].
 *
 * Each capture is kept in `<directory>/captures/<owner>/` ([KeptCaptures]). `<owner>` ([ownerOf]) names the server
 * and the person the session belongs to, not the token, so it stays the same across sign-ins of that person. Nothing
 * here is removed when the session ends: a capture is deleted only after the server created its item.
 *
 * A round ([send], [sendSoon]) sends the captures of the owner signed in now through the window's [sender], one at a
 * time in the order they were made ([CaptureDelivery]), and only one round runs at a time: a trigger while one runs
 * makes it look at the directory once more instead of starting another. A round that ended without an answer is
 * followed by another after [nextReplayDelayMillis], for as long as the process runs. [waiting] counts the captures of
 * the owner signed in.
 */
@OptIn(ExperimentalTime::class)
internal class CaptureOutbox(
    private val store: OfflineStore,
    private val scope: CoroutineScope,
    state: LayerState,
    private val clock: QueueClock,
    private val newId: () -> String,
    private val sender: () -> QueueSender?,
) {
    private val files = KeptCaptures(store)
    private val delivery = CaptureDelivery(files, state, clock)
    private val rounds = OneRoundAtATime(scope) { pass() }
    private var failedRounds = 0
    private var retry: Job? = null

    /** How many captures of the owner signed in wait, as last counted. */
    val waiting: StateFlow<Int> = files.waiting

    /**
     * Keeps [capture], made with [session], and starts a round. It fails with [FailureKind.UNAUTHORIZED], writing
     * nothing, when no person is kept for [session], and with [FailureKind.UNAVAILABLE] when its files could not be
     * written; bytes written before a JSON that failed are deleted at the next listing.
     */
    suspend fun add(session: StoredSession, capture: InboxCapture): RepositoryResult<Unit> {
        val owner = ownerOf(session) ?: return RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val kept = KeptCapture(
            version = CAPTURE_FILE_VERSION,
            id = newId(),
            text = capture.text,
            day = capture.day.toString(),
            time = capture.time,
            typeId = capture.typeId,
            file = capture.file?.let { KeptCaptureFile(it.filename, it.mimeType, it.source.wire()) },
            createdAt = clock.now(),
        )
        val written = files.add(owner, kept, capture.file?.bytes)
        if (written) sendSoon()
        return if (written) RepositoryResult.Content(Unit) else RepositoryResult.Failure(FailureKind.UNAVAILABLE)
    }

    /** Starts a round in the background, or makes the one under way look at the directory once more. */
    fun sendSoon() {
        scope.launch { rounds.join() }
    }

    /**
     * Runs a round now, or joins the one under way, and answers whether no capture of the owner signed in is left;
     * `false` when nobody is signed in or no person is kept for the session, since then nothing could be sent.
     */
    suspend fun send(): Boolean {
        rounds.join()
        val owner = signedInOwner()
        return owner != null && files.count(owner) == 0
    }

    /** The session ended: no owner is signed in, so none of the captures, which stay, is counted. */
    fun cleared() {
        files.noOwner()
    }

    /** The owner of the captures made with [session]: the server and the person kept for it; `null` with no person. */
    suspend fun ownerOf(session: StoredSession): String? =
        store.people.person(accountKey(session))?.let { person ->
            hex(sha1("${session.serverUrl}\n${person.id}".encodeToByteArray()))
        }

    /**
     * Delivers every capture of the owner signed in that is due, in the order they were made, until a delivery ends
     * the round or the session changes. A pass that went through resets the delay of the next retry.
     */
    private suspend fun pass() {
        val sender = sender()
        val owner = signedInOwner()
        if (sender == null || owner == null) {
            files.noOwner()
            return
        }
        val now = Instant.parseOrNull(clock.now())
        val due = files.list(owner).filter { it.isDue(now) }.iterator()
        var end = DeliveryEnd.ON
        while (end == DeliveryEnd.ON && due.hasNext()) {
            val capture = due.next()
            end = if (signedInOwner() == owner) {
                delivery.deliver(owner, capture, sender)
            } else {
                // Whoever is signed in now is counted by the round their sign-in starts.
                files.noOwner()
                DeliveryEnd.STOP
            }
        }
        when (end) {
            DeliveryEnd.ON -> failedRounds = 0
            DeliveryEnd.RETRY -> retryLater()
            DeliveryEnd.STOP -> Unit
        }
    }

    private fun retryLater() {
        val wait = nextReplayDelayMillis(failedRounds, clock.random)
        failedRounds += 1
        retry?.cancel()
        retry = scope.launch {
            delay(wait)
            rounds.join()
        }
    }

    private suspend fun signedInOwner(): String? = sender()?.session()?.let { ownerOf(it) }
}

/**
 * Runs [pass] in [scope] as rounds, one at a time: [join] starts a round, or joins the one under way and asks it for
 * one more pass, and returns once that round ended.
 */
private class OneRoundAtATime(private val scope: CoroutineScope, private val pass: suspend () -> Unit) {
    private val lock = Mutex()
    private var running: Deferred<Unit>? = null
    private var again = false

    suspend fun join() {
        val round = lock.withLock {
            again = true
            running ?: scope.async { passes() }.also { running = it }
        }
        round.await()
    }

    /** Passes as long as a trigger asked for one; however it ends, the next [join] starts a round. */
    private suspend fun passes() {
        var ended = false
        try {
            while (nextPass()) pass()
            ended = true
        } finally {
            if (!ended) withContext(NonCancellable) { lock.withLock { running = null } }
        }
    }

    /**
     * Whether a trigger asked for another pass. When none did the round ends here, under the lock [join] takes, so a
     * trigger either finds this round and is seen by it or finds none and starts the next.
     */
    private suspend fun nextPass(): Boolean = lock.withLock {
        if (again) {
            again = false
            true
        } else {
            running = null
            false
        }
    }
}

/** How a capture's delivery leaves the round: going [ON] with the next capture, to [RETRY] later, or to [STOP]. */
private enum class DeliveryEnd { ON, RETRY, STOP }

/**
 * Sends one capture through a sender: its file (`POST /api/blobs`, raw body) unless an uploaded blob is recorded, then
 * its item (`POST /api/inbox/items` with `Idempotency-Key: <captureId>`). Success deletes the capture and tells every
 * window. No answer ends the round to retry it after a backoff; a `5xx`, a `429` and a `401` end it until the next
 * trigger. Each keeps the capture as it is, with no limit on how often. A refusal of the item that names
 * its type sends it again at once without the type, and writes that; one that names its blob uploads the file once
 * more and sends the item again, once per delivery. Any other refusal of either request is counted and keeps the
 * capture from being sent for [REFUSED_CAPTURE_WAIT]; the round goes on.
 */
@OptIn(ExperimentalTime::class)
private class CaptureDelivery(
    private val files: KeptCaptures,
    private val state: LayerState,
    private val clock: QueueClock,
) {
    suspend fun deliver(
        owner: String,
        capture: KeptCapture,
        sender: QueueSender,
        upload: Boolean = capture.file != null && capture.blobId == null,
        uploadedAgain: Boolean = false,
    ): DeliveryEnd = when (val uploaded = if (upload) upload(owner, capture, sender) else Uploaded.Done(capture)) {
        is Uploaded.Ended -> uploaded.end
        is Uploaded.Done -> answered(owner, uploaded.capture, sender, uploadedAgain)
    }

    private suspend fun answered(
        owner: String,
        capture: KeptCapture,
        sender: QueueSender,
        uploadedAgain: Boolean,
    ): DeliveryEnd {
        val response = sender.send(itemRequest(capture))
        state.answered(response)
        return when (response) {
            is ApiResponse.Success -> {
                files.delete(owner, capture.id)
                state.changed()
                DeliveryEnd.ON
            }
            is ApiResponse.Failure ->
                response.endOfRound() ?: refusedItem(owner, capture, sender, uploadedAgain, response)
        }
    }

    private suspend fun refusedItem(
        owner: String,
        capture: KeptCapture,
        sender: QueueSender,
        uploadedAgain: Boolean,
        refusal: ApiResponse.Failure,
    ): DeliveryEnd {
        val named = refusal.namedFields()
        return when {
            capture.typeId != null && TYPE_FIELD in named -> {
                val untyped = capture.copy(typeId = null)
                // A failed write keeps the type on the device; the next refusal drops it again.
                files.write(owner, untyped)
                deliver(owner, untyped, sender, upload = false, uploadedAgain = uploadedAgain)
            }
            capture.file != null && !uploadedAgain && ATTACHMENTS_FIELD in named ->
                deliver(owner, capture, sender, upload = true, uploadedAgain = true)
            else -> refused(owner, capture)
        }
    }

    /**
     * Uploads the bytes of [capture] and records the blob. Missing bytes leave a capture never uploaded waiting as it
     * is, and count as a refusal of one uploaded before.
     */
    private suspend fun upload(owner: String, capture: KeptCapture, sender: QueueSender): Uploaded {
        val file = capture.file
        val bytes = file?.let { files.bytes(owner, capture.id) }
        return when {
            file == null -> Uploaded.Done(capture)
            bytes == null -> Uploaded.Ended(if (capture.blobId == null) DeliveryEnd.ON else refused(owner, capture))
            else -> recorded(owner, capture, sender.upload(INBOX_BLOBS_PATH, RawBody(file.mimeType, bytes)))
        }
    }

    /** Records the blob the upload of [capture] answered; an answer naming no blob counts as a refusal. */
    private suspend fun recorded(owner: String, capture: KeptCapture, response: ApiResponse): Uploaded {
        state.answered(response)
        return when (response) {
            is ApiResponse.Failure -> Uploaded.Ended(response.endOfRound() ?: refused(owner, capture))
            is ApiResponse.Success -> response.blobId()?.let { blobId ->
                val next = capture.copy(blobId = blobId, uploadedAt = clock.now())
                // A failed write keeps the capture as it was: it is uploaded again, which stores nothing new.
                files.write(owner, next)
                Uploaded.Done(next)
            } ?: Uploaded.Ended(refused(owner, capture))
        }
    }

    /** Counts a refusal of [capture] and keeps it from being sent for [REFUSED_CAPTURE_WAIT]; the round goes on. */
    private suspend fun refused(owner: String, capture: KeptCapture): DeliveryEnd {
        val next = Instant.parseOrNull(clock.now())?.plus(REFUSED_CAPTURE_WAIT)
        // A failed write keeps the capture as it was, so it is only sent again sooner.
        files.write(owner, capture.copy(attempts = capture.attempts + 1, nextAttemptAt = next?.toString()))
        return DeliveryEnd.ON
    }
}

/** An upload that recorded its blob in [Done.capture], or ended the capture's delivery with [Ended.end]. */
private sealed interface Uploaded {
    data class Done(val capture: KeptCapture) : Uploaded

    data class Ended(val end: DeliveryEnd) : Uploaded
}

/** The `POST /api/inbox/items` of [capture], with the body `HttpInboxCaptureRepository` sends and its key. */
private fun itemRequest(capture: KeptCapture): ApiRequest {
    val attachments = listOfNotNull(
        capture.file?.let { file -> capture.blobId?.let { InboxCaptureAttachmentDto(it, file.source) } },
    )
    return ApiRequest(
        HttpMethod.Post,
        INBOX_ITEMS_PATH,
        body = inboxCaptureBody(capture.text, capture.day, capture.time, capture.typeId, attachments),
        extraHeaders = listOf(IDEMPOTENCY_KEY_HEADER to capture.id),
    )
}

/** No answer ends the round to retry it, a `5xx`, a `429` and a `401` end it; `null` for a refusal. */
private fun ApiResponse.Failure.endOfRound(): DeliveryEnd? = when {
    status == null -> DeliveryEnd.RETRY
    kind == FailureKind.UNAVAILABLE || status == UNAUTHORIZED_STATUS -> DeliveryEnd.STOP
    else -> null
}

@OptIn(ExperimentalTime::class)
private fun KeptCapture.isDue(now: Instant?): Boolean {
    val next = nextAttemptAt?.let(Instant::parseOrNull) ?: return true
    return now == null || now >= next
}

private fun ApiResponse.Success.blobId(): String? = when (val decoded = decode<InboxCaptureBlobDto>()) {
    is RepositoryResult.Content -> decoded.value.blobId
    is RepositoryResult.Failure -> null
}

/** The fields a refusal names in `error.details`: its `field`, and `attachments` when it names a `blobId`. */
private fun ApiResponse.Failure.namedFields(): Set<String> {
    val details = body?.let { text ->
        decodeCaptureOrNull { ApiJson.decodeFromString(CaptureErrorDto.serializer(), text) }
    }?.error?.details
    return setOfNotNull(details?.field, details?.blobId?.let { ATTACHMENTS_FIELD })
}

@Serializable
private data class CaptureErrorDto(val error: CaptureErrorBodyDto? = null)

@Serializable
private data class CaptureErrorBodyDto(val details: CaptureErrorDetailsDto? = null)

@Serializable
private data class CaptureErrorDetailsDto(val field: String? = null, val blobId: String? = null)
