package cz.semprec.app.data

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** At most this many answers are kept per account; the least recently used one goes first. */
internal const val MAX_KEPT_ANSWERS = 500

/** An answer whose body is longer than this many bytes of UTF-8 is not kept; the one kept before it stays. */
internal const val MAX_KEPT_ANSWER_BYTES = 1_048_576

/** How many kept answers the store holds decoded in memory; the others are read from their files again. */
private const val MEMORY_ANSWERS = 100

private const val FILE_VERSION = 1
private const val ROOT = "offline"
private const val ANSWERS = "answers"
private const val INDEX = "index.json"
private const val UTF8_MAX_BYTES_PER_CHAR = 4
private const val FNV_OFFSET = -0x340d631b7bdddcdbL
private const val FNV_PRIME = 0x100000001b3L
private const val BYTE_MASK = 0xffL
private const val HEX_RADIX = 16

/** An answer of the server as the device keeps it: the status, body and `ETag` of an [ApiResponse.Success]. */
internal data class KeptAnswer(val status: Int, val body: String, val etag: String?) {
    fun toResponse(): ApiResponse.Success = ApiResponse.Success(status, body, etag)
}

/**
 * What the device keeps for the signed-in account, in a directory the system does not empty: under
 * `directory/offline/<account>`, one directory per account named by [accountKey] (a SHA-1 of the server and the
 * session token), the answers of the offline set as JSON files written with [writeCacheFile]
 * (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md).
 *
 * Each answer has a file named by a 64-bit FNV-1a hash of its request key; the file repeats the key, the account and
 * a version, and one that does not match them, or cannot be decoded, reads as nothing and is deleted. An index lists
 * the files most recently used first: at most [maxAnswers] are kept and the files that fall off its end are deleted.
 * Keeping an answer for one account removes the directories of every other. [clear] removes everything, and an
 * account it ended keeps nothing afterwards, so an answer arriving late for a session that ended is dropped.
 *
 * Every call takes the store's one lock and runs on [dispatcher], so the windows of the process, which share one
 * store per directory through [OfflineLayer.shared], never interleave their reads, writes and clears.
 */
internal class OfflineStore(
    directory: String,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val maxAnswers: Int = MAX_KEPT_ANSWERS,
) {
    private val json = Json { encodeDefaults = true }
    private val root = "${directory.trimEnd('/')}/$ROOT"
    private val lock = Mutex()

    /** The account the memory below belongs to. */
    private var account: String? = null

    /** Decoded answers by request key, least recently used first. */
    private val memory = LinkedHashMap<String, KeptAnswer>()

    /** The answer files of [account], most recently used first; `null` until read from its index. */
    private var index: MutableList<String>? = null

    /** Whether the directories of the other accounts were removed since [account] was set. */
    private var othersRemoved = false
    private val ended = HashSet<String>()

    /** The answer kept for [key], or `null`. */
    suspend fun answer(account: String, key: String): KeptAnswer? = io {
        if (account in ended) return@io null
        use(account)
        memory[key]?.let { kept ->
            remember(key, kept)
            return@io kept
        }
        val path = answerPath(account, keptAnswerFileName(key))
        val text = readCacheFile(path) ?: return@io null
        val file = decodeOrNull { json.decodeFromString(KeptAnswerFile.serializer(), text) }
        if (file == null || !file.belongsTo(account, key)) {
            deleteCachePath(path)
            return@io null
        }
        val kept = KeptAnswer(file.status, file.body, file.etag)
        remember(key, kept)
        kept
    }

    /** Keeps [answer] for [key]; an answer too long to keep leaves the one kept before. */
    suspend fun keep(account: String, key: String, answer: KeptAnswer) = io {
        if (account in ended || answer.isTooLong()) return@io
        use(account)
        if (!othersRemoved) {
            listCacheDirectory(root).filter { it != account }.forEach { deleteCachePath("$root/$it") }
            othersRemoved = true
        }
        // Read before the file is written: reading the index deletes the files it does not name.
        val names = indexOf(account)
        val name = keptAnswerFileName(key)
        val file = KeptAnswerFile(FILE_VERSION, account, key, answer.status, answer.body, answer.etag)
        if (!writeCacheFile(answerPath(account, name), json.encodeToString(KeptAnswerFile.serializer(), file))) {
            return@io
        }
        remember(key, answer)
        names.remove(name)
        names.add(0, name)
        while (names.size > maxAnswers) deleteCachePath(answerPath(account, names.removeAt(names.lastIndex)))
        writeIndex(account, names)
    }

    /** Removes the answer kept for [key]. */
    suspend fun forget(account: String, key: String) = io {
        if (account in ended) return@io
        use(account)
        memory.remove(key)
        val name = keptAnswerFileName(key)
        deleteCachePath(answerPath(account, name))
        val names = indexOf(account)
        if (names.remove(name)) writeIndex(account, names)
    }

    /** Removes everything the device keeps for every account; the account in use keeps nothing afterwards. */
    suspend fun clear() = io {
        account?.let(ended::add)
        account = null
        memory.clear()
        index = null
        othersRemoved = false
        deleteCachePath(root)
    }

    private suspend fun <T> io(block: () -> T): T = withContext(dispatcher) { lock.withLock { block() } }

    private fun use(next: String) {
        if (account == next) return
        account = next
        memory.clear()
        index = null
        othersRemoved = false
    }

    private fun remember(key: String, answer: KeptAnswer) {
        memory.remove(key)
        memory[key] = answer
        while (memory.size > MEMORY_ANSWERS) memory.remove(memory.keys.first())
    }

    /**
     * The index of [account], read once; files the index does not name (a failed index write) are deleted then, so
     * nothing stays that eviction would never reach.
     */
    private fun indexOf(account: String): MutableList<String> {
        index?.let { return it }
        val read = readCacheFile("$root/$account/$ANSWERS/$INDEX")
            ?.let { text -> decodeOrNull { json.decodeFromString(KeptIndexFile.serializer(), text) } }
            ?.names.orEmpty()
        val names = read.distinct().toMutableList()
        listCacheDirectory("$root/$account/$ANSWERS")
            .filter { it != INDEX && it.endsWith(".json") && it !in names }
            .forEach { deleteCachePath(answerPath(account, it)) }
        index = names
        return names
    }

    private fun writeIndex(account: String, names: List<String>) {
        val text = json.encodeToString(KeptIndexFile.serializer(), KeptIndexFile(names))
        writeCacheFile("$root/$account/$ANSWERS/$INDEX", text)
    }

    private fun answerPath(account: String, name: String) = "$root/$account/$ANSWERS/$name"
}

private fun KeptAnswer.isTooLong(): Boolean =
    body.length > MAX_KEPT_ANSWER_BYTES / UTF8_MAX_BYTES_PER_CHAR &&
        body.encodeToByteArray().size > MAX_KEPT_ANSWER_BYTES

/** A 64-bit FNV-1a hash of the request key; the file holds the key, so two keys never share a file's content. */
internal fun keptAnswerFileName(key: String): String {
    var hash = FNV_OFFSET
    key.encodeToByteArray().forEach { byte -> hash = (hash xor (byte.toLong() and BYTE_MASK)) * FNV_PRIME }
    return "${hash.toULong().toString(HEX_RADIX)}.json"
}

private inline fun <T> decodeOrNull(decode: () -> T): T? = try {
    decode()
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

@Serializable
private data class KeptIndexFile(val names: List<String>)

@Serializable
private data class KeptAnswerFile(
    val version: Int,
    val account: String,
    val key: String,
    val status: Int,
    val body: String,
    val etag: String? = null,
) {
    fun belongsTo(account: String, key: String) = version == FILE_VERSION && this.account == account && this.key == key
}
