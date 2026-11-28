package cz.semprec.app.data

import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.InboxCaptureSource
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

internal const val CAPTURE_FILE_VERSION = 1
private const val CAPTURES = "captures"
private const val CAPTURE_JSON = ".json"
private const val CAPTURE_BYTES = ".bin"

/** The file attached to a kept capture: its name, media type and `source` as the server names it. */
@Serializable
internal data class KeptCaptureFile(val name: String, val mimeType: String, val source: String)

/**
 * One capture as `<captureId>.json` holds it: what the person captured ([text], [day] `YYYY-MM-DD`, [time] `HH:mm`,
 * [typeId]), the [file] when one is attached (its bytes are `<captureId>.bin` beside it), the [blobId] of its upload
 * and when it was uploaded, how often the server refused it, when it may be sent next ([nextAttemptAt], `null` at
 * once) and when it was made. [id] is also its `Idempotency-Key`.
 */
@Serializable
internal data class KeptCapture(
    val version: Int,
    val id: String,
    val text: String,
    val day: String,
    val time: String,
    val typeId: String? = null,
    val file: KeptCaptureFile? = null,
    val blobId: String? = null,
    val uploadedAt: String? = null,
    val attempts: Int = 0,
    val nextAttemptAt: String? = null,
    val createdAt: String,
)

/**
 * The files of the captures in `<directory>/captures/<owner>/`, outside the `offline` directory that [OfflineStore]
 * removes when the session ends: `<captureId>.json` and, with a file, `<captureId>.bin`. Each is written beside its
 * target and moved over it ([writeCacheFile], [writeCacheBytes]), and the bytes before the JSON, so a capture exists
 * once its JSON exists. Every call takes one lock and runs on the store's dispatcher, so a listing never deletes the
 * bytes of a capture being added. [waiting] is the number of captures of the owner listed, added to or deleted from
 * last, and 0 after [noOwner].
 */
@OptIn(ExperimentalTime::class)
internal class KeptCaptures(private val store: OfflineStore) {
    private val root = "${store.directory}/$CAPTURES"
    private val lock = Mutex()
    private val mutableWaiting = MutableStateFlow(0)

    val waiting: StateFlow<Int> = mutableWaiting.asStateFlow()

    /** Writes the [bytes] of [capture], when it has a file, then its JSON; whether both were written. */
    suspend fun add(owner: String, capture: KeptCapture, bytes: ByteArray?): Boolean = locked {
        val bytesWritten = bytes == null || writeCacheBytes(captureFile(root, owner, capture.id, CAPTURE_BYTES), bytes)
        val written = bytesWritten && writeJson(owner, capture)
        mutableWaiting.value = jsonCount(captureDirectory(root, owner))
        written
    }

    /**
     * The readable captures of [owner], the oldest first, after deleting every `.bin` without its JSON; [waiting]
     * becomes the number of JSON files, readable or not. A JSON that cannot be read stays, and so do its bytes.
     */
    suspend fun list(owner: String): List<KeptCapture> = locked {
        val directory = captureDirectory(root, owner)
        val names = listCacheDirectory(directory)
        val ids = names.filter { it.endsWith(CAPTURE_JSON) }.map { it.removeSuffix(CAPTURE_JSON) }.toSet()
        names.filter { it.endsWith(CAPTURE_BYTES) && it.removeSuffix(CAPTURE_BYTES) !in ids }
            .forEach { deleteCachePath("$directory/$it") }
        mutableWaiting.value = ids.size
        readable(store, root, owner, ids)
    }

    /** The readable captures of [owner], the oldest first, read without deleting or counting anything. */
    suspend fun captures(owner: String): List<KeptCapture> = locked {
        val ids = listCacheDirectory(captureDirectory(root, owner))
            .filter { it.endsWith(CAPTURE_JSON) }
            .map { it.removeSuffix(CAPTURE_JSON) }
        readable(store, root, owner, ids)
    }

    /** How many captures of [owner] there are. */
    suspend fun count(owner: String): Int = locked { jsonCount(captureDirectory(root, owner)) }

    /** The bytes of the file of capture [id], or `null` when they are missing. */
    suspend fun bytes(owner: String, id: String): ByteArray? =
        locked { readCacheBytes(captureFile(root, owner, id, CAPTURE_BYTES)) }

    /** Replaces the JSON of [capture]; a failed write leaves the one before it. */
    suspend fun write(owner: String, capture: KeptCapture): Boolean = locked { writeJson(owner, capture) }

    /** Deletes the JSON first, so the capture is gone even when its bytes are left for the next listing to delete. */
    suspend fun delete(owner: String, id: String) = locked {
        deleteCachePath(captureFile(root, owner, id, CAPTURE_JSON))
        deleteCachePath(captureFile(root, owner, id, CAPTURE_BYTES))
        mutableWaiting.value = jsonCount(captureDirectory(root, owner))
    }

    /** Nobody whose captures could be counted is signed in. */
    fun noOwner() {
        mutableWaiting.value = 0
    }

    private suspend fun <T> locked(block: () -> T): T = withContext(store.dispatcher) { lock.withLock { block() } }

    private fun writeJson(owner: String, capture: KeptCapture): Boolean = writeCacheFile(
        captureFile(root, owner, capture.id, CAPTURE_JSON),
        store.json.encodeToString(KeptCapture.serializer(), capture),
    )
}

private fun captureDirectory(root: String, owner: String) = "$root/$owner"

private fun captureFile(root: String, owner: String, id: String, suffix: String) = "$root/$owner/$id$suffix"

private fun jsonCount(directory: String): Int = listCacheDirectory(directory).count { it.endsWith(CAPTURE_JSON) }

/** The captures [ids] of [owner] that can be read, the oldest first. */
@OptIn(ExperimentalTime::class)
private fun readable(store: OfflineStore, root: String, owner: String, ids: Collection<String>): List<KeptCapture> =
    ids.mapNotNull { id -> readCapture(store, captureFile(root, owner, id, CAPTURE_JSON), id) }
        .sortedWith(compareBy<Pair<Instant, KeptCapture>> { it.first }.thenBy { it.second.id })
        .map { it.second }

/** The capture [id] in the JSON at [path] with the time it was made, or `null` when it cannot be read. */
@OptIn(ExperimentalTime::class)
private fun readCapture(store: OfflineStore, path: String, id: String): Pair<Instant, KeptCapture>? {
    val text = readCacheFile(path) ?: return null
    val capture = decodeCaptureOrNull { store.json.decodeFromString(KeptCapture.serializer(), text) }
    val createdAt = capture?.createdAt?.let(Instant::parseOrNull)
    val readable = capture != null && createdAt != null && capture.version == CAPTURE_FILE_VERSION &&
        capture.id == id && CalendarDay.parse(capture.day) != null &&
        (capture.nextAttemptAt == null || Instant.parseOrNull(capture.nextAttemptAt) != null) &&
        (capture.file == null || InboxCaptureSource.entries.any { it.wire() == capture.file.source })
    return if (readable) createdAt to capture else null
}

internal inline fun <T> decodeCaptureOrNull(decode: () -> T): T? = try {
    decode()
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}
