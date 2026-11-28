package cz.alldots.app.data

import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.MailNamedRef
import cz.alldots.app.domain.MailThreadKey
import cz.alldots.app.domain.MailThreadList
import cz.alldots.app.domain.MailThreadListCache
import cz.alldots.app.domain.MailThreadQuery
import cz.alldots.app.domain.MailThreadSummary
import io.ktor.util.hex
import io.ktor.util.sha1
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** A list of more rows than this is not kept; the list kept before stays. */
internal const val MAIL_LIST_CACHE_MAX_ROWS = 500

/** At most this many views are kept per account; the least recently used one goes first. */
internal const val MAIL_LIST_CACHE_MAX_VIEWS = 20

private const val FILE_VERSION = 1
private const val ROOT = "mail-threads"
private const val INDEX = "views.json"
private const val FNV_OFFSET = -0x340d631b7bdddcdbL
private const val FNV_PRIME = 0x100000001b3L
private const val BYTE_MASK = 0xffL
private const val HEX_RADIX = 16

/**
 * Keeps the thread lists of the signed-in account as JSON files under `directory/mail-threads`: one directory per
 * account, named by a SHA-1 of the server and the session token so that neither appears in a path, one file per view,
 * and an index of the views, most recently used first. Writing for one account removes the lists of every other.
 * Signed out, it keeps and finds nothing. A file it cannot decode, or one of another version, account or view, reads
 * as nothing and is deleted. A failed write leaves the file before it, which is still a list to go on from. Every
 * cache of the process over the same directory (one per Apple window) takes the same lock, so their reads, writes
 * and clears never interleave.
 */
class FileMailThreadListCache internal constructor(
    private val directory: String,
    private val account: () -> String?,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : MailThreadListCache {
    /** The account is the session [api] signs in with. */
    constructor(directory: String, api: AuthenticatedApi) : this(directory, { api.session()?.let(::accountKey) })

    private val json = Json { encodeDefaults = true }
    private val root = "${directory.trimEnd('/')}/$ROOT"

    override suspend fun read(view: MailThreadQuery): MailThreadList? = io {
        val account = account() ?: return@io null
        val name = fileName(view)
        val path = "$root/$account/$name"
        val file = readCacheFile(path)?.let(::decodeList)
        if (file?.belongsTo(account, viewKey(view)) != true) {
            deleteCachePath(path)
            return@io null
        }
        remember(account, name)
        file.toDomain()
    }

    override suspend fun write(view: MailThreadQuery, list: MailThreadList) = io {
        val account = account() ?: return@io
        if (list.threads.size > MAIL_LIST_CACHE_MAX_ROWS) return@io
        listCacheDirectory(root).filter { it != account }.forEach { deleteCachePath("$root/$it") }
        val name = fileName(view)
        val file = list.toFile(account, viewKey(view))
        if (writeCacheFile("$root/$account/$name", json.encodeToString(CachedListFile.serializer(), file))) {
            remember(account, name)
        }
    }

    override suspend fun clear() = io { deleteCachePath(root) }

    private suspend fun <T> io(block: () -> T): T =
        withContext(dispatcher) { CacheRootLocks.of(root).withLock { block() } }

    /** Moves [name] to the front of the account's index and deletes the views that fall off its end. */
    private fun remember(account: String, name: String) {
        val path = "$root/$account/$INDEX"
        val known = readCacheFile(path)?.let(::decodeIndex)?.views.orEmpty()
        val views = (listOf(name) + known.filter { it != name }).distinct()
        views.drop(MAIL_LIST_CACHE_MAX_VIEWS).forEach { deleteCachePath("$root/$account/$it") }
        val kept = views.take(MAIL_LIST_CACHE_MAX_VIEWS)
        writeCacheFile(path, json.encodeToString(CachedIndexFile.serializer(), CachedIndexFile(kept)))
        // A view file the index lost (a failed index write) would never be evicted.
        listCacheDirectory("$root/$account")
            .filter { it != INDEX && it !in kept && it.endsWith(".json") }
            .forEach { deleteCachePath("$root/$account/$it") }
    }

    private fun decodeList(text: String): CachedListFile? = decodeOrNull {
        json.decodeFromString(CachedListFile.serializer(), text)
    }

    private fun decodeIndex(text: String): CachedIndexFile? =
        decodeOrNull { json.decodeFromString(CachedIndexFile.serializer(), text) }
}

/** One lock per cache root for the whole process, created when a cache first uses that root. */
private object CacheRootLocks {
    private val guard = Mutex()
    private val locks = HashMap<String, Mutex>()

    suspend fun of(root: String): Mutex = guard.withLock { locks.getOrPut(root) { Mutex() } }
}

private fun CachedListFile.belongsTo(account: String, view: String) =
    version == FILE_VERSION && this.account == account && this.view == view

private inline fun <T> decodeOrNull(decode: () -> T): T? = try {
    decode()
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

/** Names the account by the session it signs in with, without putting the token into a path. */
internal fun accountKey(session: StoredSession): String =
    hex(sha1("${session.serverUrl}\n${session.token}".encodeToByteArray()))

/** The filters that name the view, in a fixed order; a search and a page cursor are not part of it. */
internal fun viewKey(view: MailThreadQuery): String = listOf(
    "box=${view.box.name}",
    "mailbox=${view.mailboxId.orEmpty()}",
    "folder=${view.folderId.orEmpty()}",
    "project=${view.projectId.orEmpty()}",
    "unread=${view.unreadOnly}",
).joinToString("&")

/** A 64-bit FNV-1a hash of the view key; the file holds the key, so two views never share a file's content. */
private fun fileName(view: MailThreadQuery): String {
    var hash = FNV_OFFSET
    viewKey(view).encodeToByteArray().forEach { byte ->
        hash = (hash xor (byte.toLong() and BYTE_MASK)) * FNV_PRIME
    }
    return "${hash.toULong().toString(HEX_RADIX)}.json"
}

@Serializable
private data class CachedIndexFile(val views: List<String>)

@Serializable
private data class CachedListFile(
    val version: Int,
    val account: String,
    val view: String,
    val changesCursor: String?,
    val nextCursor: String?,
    val windowEnd: CachedKey?,
    val threads: List<CachedThread>,
)

@Serializable
private data class CachedKey(val lastMessageAt: String, val threadId: String)

@Serializable
private data class CachedRef(val id: String, val name: String)

@Serializable
private data class CachedThread(
    val threadId: String,
    val subject: String,
    val lastMessageAt: String,
    val senderName: String,
    val senderAddress: String,
    val senderRelationship: String?,
    val messageCount: Int,
    val preview: String?,
    val hasAttachment: Boolean,
    val unread: Boolean,
    val flagged: Boolean,
    val mailboxNames: List<String>,
    val project: CachedRef?,
    val company: CachedRef?,
    val hasSempDraft: Boolean,
)

private fun MailThreadList.toFile(account: String, view: String) = CachedListFile(
    version = FILE_VERSION,
    account = account,
    view = view,
    changesCursor = changesCursor,
    nextCursor = nextCursor,
    windowEnd = windowEnd?.let { CachedKey(it.lastMessageAt, it.threadId) },
    threads = threads.map { thread ->
        CachedThread(
            threadId = thread.threadId,
            subject = thread.subject,
            lastMessageAt = thread.lastMessageAt,
            senderName = thread.senderName,
            senderAddress = thread.senderAddress,
            senderRelationship = thread.senderRelationship,
            messageCount = thread.messageCount,
            preview = thread.preview,
            hasAttachment = thread.hasAttachment,
            unread = thread.unread,
            flagged = thread.flagged,
            mailboxNames = thread.mailboxNames,
            project = thread.project?.let { CachedRef(it.id, it.name) },
            company = thread.company?.let { CachedRef(it.id, it.name) },
            hasSempDraft = thread.hasSempDraft,
        )
    },
)

private fun CachedListFile.toDomain() = MailThreadList(
    threads = threads.map { thread ->
        MailThreadSummary(
            threadId = thread.threadId,
            subject = thread.subject,
            lastMessageAt = thread.lastMessageAt,
            senderName = thread.senderName,
            senderAddress = thread.senderAddress,
            senderRelationship = thread.senderRelationship,
            messageCount = thread.messageCount,
            preview = thread.preview,
            hasAttachment = thread.hasAttachment,
            unread = thread.unread,
            flagged = thread.flagged,
            mailboxNames = thread.mailboxNames,
            project = thread.project?.let { MailNamedRef(it.id, it.name) },
            company = thread.company?.let { MailNamedRef(it.id, it.name) },
            hasSempDraft = thread.hasSempDraft,
        )
    },
    nextCursor = nextCursor,
    changesCursor = changesCursor,
    windowEnd = windowEnd?.let { MailThreadKey(it.lastMessageAt, it.threadId) },
)
