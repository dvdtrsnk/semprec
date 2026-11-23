package cz.semprec.app.data

import cz.semprec.app.domain.SessionUser
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

internal const val OFFLINE_FILE_VERSION = 1
private const val ROOT = "offline"
private const val ANSWERS = "answers"
private const val INDEX = "index.json"
private const val PERSON = "session.json"
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
 * session token), JSON files written with [writeCacheFile]
 * (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md). [answers] holds the answers of the offline
 * set, [people] the person the server last confirmed for the session.
 *
 * Keeping anything for one account removes the directories of every other. [clear] removes everything, and an
 * account it ended keeps nothing afterwards, so an answer arriving late for a session that ended is dropped. Every
 * call takes the store's one lock and runs on [dispatcher], so the windows of the process, which share one store per
 * directory through [OfflineLayer.shared], never interleave their reads, writes and clears.
 */
internal class OfflineStore(
    directory: String,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    maxAnswers: Int = MAX_KEPT_ANSWERS,
) {
    val root = "${directory.trimEnd('/')}/$ROOT"
    val json = Json { encodeDefaults = true }
    private val lock = Mutex()

    /** The account the memory of the parts belongs to. */
    private var current: String? = null

    /** Whether the directories of the other accounts were removed since [current] was set. */
    private var othersRemoved = false
    private val ended = HashSet<String>()

    val answers = KeptAnswers(this, maxAnswers)
    val people = KeptPeople(this)

    /**
     * Runs [block] for [account] with the lock held, on [dispatcher]; `null` without running it when the account's
     * session ended. With [keeping], the directories of every other account are removed first.
     */
    suspend fun <T> using(account: String, keeping: Boolean, block: () -> T): T? = withContext(dispatcher) {
        lock.withLock {
            if (account in ended) return@withLock null
            if (current != account) {
                current = account
                othersRemoved = false
                answers.reset()
            }
            if (keeping && !othersRemoved) {
                listCacheDirectory(root).filter { it != account }.forEach { deleteCachePath("$root/$it") }
                othersRemoved = true
            }
            block()
        }
    }

    /** Removes everything the device keeps for every account; the account in use keeps nothing afterwards. */
    suspend fun clear() = withContext(dispatcher) {
        lock.withLock {
            current?.let(ended::add)
            current = null
            othersRemoved = false
            answers.reset()
            deleteCachePath(root)
        }
    }
}

/**
 * The answers of the offline set: one file per answer under `<account>/answers/`, named by a 64-bit FNV-1a hash of its
 * request key, repeating the key, the account and a version; a file that does not match them, or cannot be decoded,
 * reads as nothing and is deleted. An index lists the files most recently kept first: at most [maxAnswers] are kept
 * and the files that fall off its end are deleted. The last [MEMORY_ANSWERS] answers used stay decoded in memory.
 */
internal class KeptAnswers(private val store: OfflineStore, private val maxAnswers: Int) {
    /** Decoded answers by request key, least recently used first. */
    private val memory = LinkedHashMap<String, KeptAnswer>()

    /** The answer files of the account in use, most recently kept first; `null` until read from its index. */
    private var index: MutableList<String>? = null

    /** The answer kept for [key], or `null`. */
    suspend fun answer(account: String, key: String): KeptAnswer? = store.using(account, keeping = false) {
        memory[key]?.let { kept ->
            remember(key, kept)
            return@using kept
        }
        val path = path(account, keptAnswerFileName(key))
        val text = readCacheFile(path) ?: return@using null
        val file = decodeOrNull { store.json.decodeFromString(KeptAnswerFile.serializer(), text) }
        if (file == null || !file.belongsTo(account, key)) {
            deleteCachePath(path)
            return@using null
        }
        KeptAnswer(file.status, file.body, file.etag).also { remember(key, it) }
    }

    /** Keeps [answer] for [key]; an answer too long to keep leaves the one kept before. */
    suspend fun keep(account: String, key: String, answer: KeptAnswer) {
        if (answer.isTooLong()) return
        store.using(account, keeping = true) {
            // Read before the file is written: reading the index deletes the files it does not name.
            val names = indexOf(account)
            val name = keptAnswerFileName(key)
            val file = KeptAnswerFile(OFFLINE_FILE_VERSION, account, key, answer.status, answer.body, answer.etag)
            if (writeCacheFile(path(account, name), store.json.encodeToString(KeptAnswerFile.serializer(), file))) {
                remember(key, answer)
                names.remove(name)
                names.add(0, name)
                while (names.size > maxAnswers) deleteCachePath(path(account, names.removeAt(names.lastIndex)))
                writeIndex(account, names)
            }
        }
    }

    /** Removes the answer kept for [key]. */
    suspend fun forget(account: String, key: String) {
        store.using(account, keeping = false) {
            memory.remove(key)
            val name = keptAnswerFileName(key)
            deleteCachePath(path(account, name))
            val names = indexOf(account)
            if (names.remove(name)) writeIndex(account, names)
        }
    }

    /** Forgets what is held in memory; called by the store, with its lock held, when the account changes or ends. */
    fun reset() {
        memory.clear()
        index = null
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
        val read = readCacheFile("${store.root}/$account/$ANSWERS/$INDEX")
            ?.let { text -> decodeOrNull { store.json.decodeFromString(KeptIndexFile.serializer(), text) } }
            ?.names.orEmpty()
        val names = read.distinct().toMutableList()
        listCacheDirectory("${store.root}/$account/$ANSWERS")
            .filter { it != INDEX && it.endsWith(".json") && it !in names }
            .forEach { deleteCachePath(path(account, it)) }
        index = names
        return names
    }

    private fun writeIndex(account: String, names: List<String>) {
        val text = store.json.encodeToString(KeptIndexFile.serializer(), KeptIndexFile(names))
        writeCacheFile("${store.root}/$account/$ANSWERS/$INDEX", text)
    }

    private fun path(account: String, name: String) = "${store.root}/$account/$ANSWERS/$name"
}

/**
 * The person the server last confirmed for the session of an account, in `<account>/session.json`, so the app can
 * open signed in without a connection; a file that does not match the account or version, or cannot be decoded,
 * reads as nothing and is deleted.
 */
internal class KeptPeople(private val store: OfflineStore) {
    /** The kept person of [account], or `null`. */
    suspend fun person(account: String): SessionUser? = store.using(account, keeping = false) {
        val path = "${store.root}/$account/$PERSON"
        val text = readCacheFile(path) ?: return@using null
        val file = decodeOrNull { store.json.decodeFromString(KeptPersonFile.serializer(), text) }
        if (file == null || file.version != OFFLINE_FILE_VERSION || file.account != account) {
            deleteCachePath(path)
            return@using null
        }
        SessionUser(file.id, file.email, file.locale, file.role, file.displayName)
    }

    /** Keeps [person] as the one the server confirmed for the session of [account]. */
    suspend fun keep(account: String, person: SessionUser) {
        store.using(account, keeping = true) {
            val file = KeptPersonFile(
                OFFLINE_FILE_VERSION,
                account,
                person.id,
                person.email,
                person.locale,
                person.role,
                person.displayName,
            )
            val text = store.json.encodeToString(KeptPersonFile.serializer(), file)
            writeCacheFile("${store.root}/$account/$PERSON", text)
        }
    }
}

private fun KeptAnswer.isTooLong(): Boolean =
    body.length > MAX_KEPT_ANSWER_BYTES / UTF8_MAX_BYTES_PER_CHAR &&
        body.encodeToByteArray().size > MAX_KEPT_ANSWER_BYTES

/** A 64-bit FNV-1a hash of [key]; the file holds the key, so two keys never share a file's content. */
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
    fun belongsTo(account: String, key: String) =
        version == OFFLINE_FILE_VERSION && this.account == account && this.key == key
}

@Serializable
private data class KeptPersonFile(
    val version: Int,
    val account: String,
    val id: String,
    val email: String,
    val locale: String,
    val role: String,
    val displayName: String? = null,
)
