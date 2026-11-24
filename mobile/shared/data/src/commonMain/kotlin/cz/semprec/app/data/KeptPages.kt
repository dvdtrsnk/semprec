package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.note.NoteMerge
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

/** How often a write of a page merges with what changed elsewhere before it answers [PageWrite.Conflict]. */
internal const val MAX_PAGE_MERGE_ROUNDS = 3

private const val PAGES = "pages"
private const val NOT_FOUND_STATUS = 404
private const val CONFLICT_STATUS = 409
private const val PRECONDITION_FAILED_STATUS = 412

/** How many merged pages wait for a slow collector of [OfflinePages.changed] before the oldest is dropped. */
private const val WAITING_PAGE_CHANGES = 16
private val MARKDOWN = ContentType.parse("text/markdown; charset=utf-8")

/**
 * A note page kept on the device: what the server last held ([base] with its [etag], `null` when the device never
 * read it) and what the person wrote since that the server does not hold yet ([local]).
 */
internal data class KeptPage(val itemId: String, val base: String?, val etag: String?, val local: String?) {
    /** What the editor shows: the local text when there is one, else the base, with the base's version. */
    fun document(): PageDocument = PageDocument(local ?: base.orEmpty(), etag.orEmpty())
}

/**
 * The note pages of the account, one file per page under `<account>/pages/`, named by a 64-bit FNV-1a hash of its item
 * id and repeating the id, the account and a version; a file of another version or account, or one that cannot be
 * decoded, reads as nothing and is deleted, and one naming another item reads as nothing
 * (docs/adr/2026-11-23-note-edits-merge-three-ways-and-wait-on-the-device.md).
 */
internal class KeptPages(private val store: OfflineStore) {
    suspend fun page(account: String, itemId: String): KeptPage? = store.using(account, keeping = false) {
        read(account, keptAnswerFileName(itemId))?.takeIf { it.itemId == itemId }
    }

    suspend fun keep(account: String, page: KeptPage) {
        store.using(account, keeping = true) {
            val file = KeptPageFile(OFFLINE_FILE_VERSION, account, page.itemId, page.base, page.etag, page.local)
            val text = store.json.encodeToString(KeptPageFile.serializer(), file)
            writeCacheFile(path(account, keptAnswerFileName(page.itemId)), text)
        }
    }

    suspend fun forget(account: String, itemId: String) {
        store.using(account, keeping = false) { deleteCachePath(path(account, keptAnswerFileName(itemId))) }
    }

    /** The pages with a local text the server does not hold yet, each with that text. */
    suspend fun waiting(account: String): List<Pair<KeptPage, String>> = store.using(account, keeping = false) {
        listCacheDirectory("${store.root}/$account/$PAGES").mapNotNull { name -> read(account, name) }
            .mapNotNull { page -> page.local?.let { page to it } }
    }.orEmpty()

    private fun read(account: String, name: String): KeptPage? {
        val path = path(account, name)
        val text = readCacheFile(path) ?: return null
        val file = decoded(text)?.takeIf { it.version == OFFLINE_FILE_VERSION && it.account == account }
        if (file == null) deleteCachePath(path)
        return file?.let { KeptPage(it.itemId, it.base, it.etag, it.local) }
    }

    /** The file [text] holds, or `null` when it is not one: a file of another version, or a damaged one. */
    private fun decoded(text: String): KeptPageFile? = try {
        store.json.decodeFromString(KeptPageFile.serializer(), text)
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun path(account: String, name: String) = "${store.root}/$account/$PAGES/$name"
}

@Serializable
private data class KeptPageFile(
    val version: Int,
    val account: String,
    val itemId: String,
    val base: String? = null,
    val etag: String? = null,
    val local: String? = null,
)

/**
 * Note pages read and written through the device (docs/adr/2026-11-23-note-edits-merge-three-ways-and-wait-on-the-
 * device.md), one at a time for every window of the process that shares the layer, so a write in the background and
 * the write of a window never interleave.
 *
 * A read returns the kept page without a request while no change signal came since it was kept, and without a
 * connection; otherwise it reads the server, which becomes the base, unless a local text waits, which is written
 * first. A write names the Markdown it was edited from: when the device holds another text of the page by then (a
 * write in the background or from another window came meanwhile), the write is merged three ways with that text
 * first. The text is kept, then written as [PageSync] describes. A page of an item the device created and the server
 * has not answered yet waits for the server's id; the queue's map of ids names it afterwards. [changed] emits the
 * item id of every page whose write merged, so every window showing it reads it again.
 */
class OfflinePages internal constructor(
    private val store: OfflineStore,
    private val state: LayerState,
    private val sender: () -> QueueSender?,
) {
    private val lock = Mutex()
    private val sync = PageSync(store, state)
    private val mutableChanged = MutableSharedFlow<String>(
        extraBufferCapacity = WAITING_PAGE_CHANGES,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** The item id of each page whose write merged with what changed elsewhere. */
    val changed: Flow<String> = mutableChanged.asSharedFlow()

    internal suspend fun read(itemId: String): RepositoryResult<PageDocument> = lock.withLock {
        val sender = sender()
        val account = sender?.account() ?: return@withLock RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val queued = store.queue.state(account)
        val target = queued.serverIdOf(itemId)
        val kept = store.pages.page(account, target) ?: store.pages.page(account, itemId)
        val served = state.locked { state.connectivity.offline || state.freshness.isFresh(account, pageKey(target)) }
        when {
            kept != null && served -> RepositoryResult.Content(kept.document())
            queued.waitsFor(target) -> RepositoryResult.Content(kept?.document() ?: PageDocument("", ""))
            kept?.local != null ->
                writtenFirst(PageWriting(account, sender, kept.local), kept.copy(itemId = target), itemId)
            else -> sync.fetched(account, target, kept, sender)
        }
    }

    internal suspend fun write(
        itemId: String,
        markdown: String,
        etag: String,
        base: String,
    ): RepositoryResult<PageWrite> = lock.withLock {
        val sender = sender()
        val account = sender?.account() ?: return@withLock RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val queued = store.queue.state(account)
        val target = queued.serverIdOf(itemId)
        val kept = store.pages.page(account, target) ?: store.pages.page(account, itemId)
        val current = kept?.let { it.local ?: it.base }
        val text = if (current == null || current == base) markdown else NoteMerge.merge(base, markdown, current)
        val fresh = KeptPage(target, base.takeIf { etag.isNotEmpty() }, etag.takeIf { it.isNotEmpty() }, null)
        val page = (kept ?: fresh).copy(itemId = target, local = text)
        store.pages.keep(account, page)
        if (target != itemId) store.pages.forget(account, itemId)
        val written = if (queued.waitsFor(target)) {
            RepositoryResult.Content(page.held(text, markdown))
        } else {
            sync.push(PageWriting(account, sender, markdown), page, text)
        }
        told(itemId, target, written)
        written
    }

    /** The local text of the page of [itemId] that the server does not hold yet, or `null`. */
    internal suspend fun localText(itemId: String): String? {
        val account = sender()?.account() ?: return null
        val target = store.queue.state(account).serverIdOf(itemId)
        return (store.pages.page(account, target) ?: store.pages.page(account, itemId))?.local
    }

    /** The id the device made for the page of the diary [periodPath] (`/api/journal/periods/:type/:period`), if any. */
    internal suspend fun periodItemId(periodPath: String): String? {
        val account = sender()?.account() ?: return null
        val writes = store.queue.state(account)?.writes.orEmpty()
        return writes.firstOrNull { it.path == "$periodPath/doc" && it.newId != null }?.newId
    }

    /** Writes every page with a local text whose item the server knows, telling the windows of each merge. */
    internal suspend fun writeWaiting() = lock.withLock {
        val sender = sender()
        val account = sender?.account() ?: return@withLock
        store.pages.waiting(account).forEach { (page, text) ->
            val queued = store.queue.state(account)
            val target = queued.serverIdOf(page.itemId)
            if (queued.waitsFor(target)) return@forEach
            val moved = page.copy(itemId = target)
            if (target != page.itemId) {
                store.pages.keep(account, moved)
                store.pages.forget(account, page.itemId)
            }
            told(page.itemId, target, sync.push(PageWriting(account, sender, text), moved, text))
        }
    }

    /**
     * Writes the local text of [page] before it is read by [itemId], and answers what the device holds of the page
     * afterwards: nothing is kept when the server no longer has the item.
     */
    private suspend fun writtenFirst(
        writing: PageWriting,
        page: KeptPage,
        itemId: String,
    ): RepositoryResult<PageDocument> {
        val written = sync.push(writing, page, writing.sent)
        told(itemId, page.itemId, written)
        val now = store.pages.page(writing.account, page.itemId)
            ?: return written as? RepositoryResult.Failure ?: RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        return RepositoryResult.Content(now.document())
    }

    /** Tells every window of a merged page, by the id it was written under and by the server's. */
    private fun told(itemId: String, target: String, written: RepositoryResult<PageWrite>) {
        if (written is RepositoryResult.Content && written.value is PageWrite.Merged) {
            mutableChanged.tryEmit(itemId)
            if (target != itemId) mutableChanged.tryEmit(target)
        }
    }
}

/** A write of a page under way: the account it is kept for, the sender, and the Markdown the writer sent. */
private class PageWriting(val account: String, val sender: QueueSender, val sent: String)

/**
 * The requests of [OfflinePages], keeping what each answer leaves in [store]. A write sends the local text against
 * the base's version. A success makes it the base, keeps the page fresh and makes every other kept answer stale (the
 * diary's period answer shows the text). A `409` or `412` reads the server, merges base, local and server with
 * [NoteMerge] and sends the merge, up to [MAX_PAGE_MERGE_ROUNDS] times. No answer, a `5xx` or a `429` keeps the text
 * on the device, and a `404` forgets the page with its local text: the server no longer has its item.
 */
private class PageSync(private val store: OfflineStore, private val state: LayerState) {
    /**
     * Sends [text], the local text of [page], merging with the server's text on a stale version. The answer compares
     * what the page holds afterwards with what the writer sent: the same text is [PageWrite.Saved] or [PageWrite.Kept],
     * another one [PageWrite.Merged].
     */
    suspend fun push(writing: PageWriting, page: KeptPage, text: String, round: Int = 0): RepositoryResult<PageWrite> =
        when (val step = attempt(writing, page, text, last = round == MAX_PAGE_MERGE_ROUNDS)) {
            is Attempt.Saved -> RepositoryResult.Content(
                if (step.text == writing.sent) PageWrite.Saved(step.etag) else PageWrite.Merged(step.etag, step.text),
            )
            Attempt.Waits -> RepositoryResult.Content(page.held(text, writing.sent))
            is Attempt.Finished -> step.result
            is Attempt.Rebased -> push(writing, step.page, step.text, round + 1)
        }

    /** Reads the server's page of [itemId], which becomes the base; [kept] answers when the server cannot. */
    suspend fun fetched(
        account: String,
        itemId: String,
        kept: KeptPage?,
        sender: QueueSender,
    ): RepositoryResult<PageDocument> {
        val sentAt = state.locked { state.freshness.signal }
        val response = sender.send(ApiRequest(HttpMethod.Get, pagePath(itemId)))
        state.answered(response)
        val etag = (response as? ApiResponse.Success)?.etag
        return when {
            response is ApiResponse.Success && etag != null -> {
                store.pages.keep(account, KeptPage(itemId, response.body, etag, null))
                state.locked { state.freshness.kept(account, pageKey(itemId), sentAt) }
                RepositoryResult.Content(PageDocument(response.body, etag))
            }
            response is ApiResponse.Success -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
            response.waits() -> kept?.let { RepositoryResult.Content(it.document()) }
                ?: RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            response.isGone() -> {
                gone(account, itemId)
                RepositoryResult.Failure(FailureKind.NOT_FOUND)
            }
            else -> RepositoryResult.Failure(response.failureKind())
        }
    }

    /** One write of [text]; a page without a version reads the server first, as does a stale one before the [last]. */
    private suspend fun attempt(writing: PageWriting, page: KeptPage, text: String, last: Boolean): Attempt {
        val etag = page.etag ?: return rebased(writing, page, text)
        val answer = send(writing.sender, page.itemId, text, etag)
        return when {
            answer is ApiResponse.Success -> saved(writing.account, page, text, answer.etag ?: etag)
            answer.waits() -> Attempt.Waits
            answer.isGone() -> gone(writing.account, page.itemId)
            !answer.isStale() -> Attempt.Finished(RepositoryResult.Failure(answer.failureKind()))
            last -> Attempt.Finished(RepositoryResult.Content(PageWrite.Conflict))
            else -> rebased(writing, page, text)
        }
    }

    /** The server holds [text] at [etag]: it is the base and stays fresh; every other kept answer turns stale. */
    private suspend fun saved(account: String, page: KeptPage, text: String, etag: String): Attempt {
        store.pages.keep(account, page.copy(base = text, etag = etag, local = null))
        state.locked {
            state.freshness.wrote()
            state.freshness.kept(account, pageKey(page.itemId), state.freshness.signal)
        }
        return Attempt.Saved(etag, text)
    }

    /** The server no longer has the item of the page: nothing is kept of it, its local text included. */
    private suspend fun gone(account: String, itemId: String): Attempt.Finished {
        store.pages.forget(account, itemId)
        state.locked { state.freshness.forgot(account, pageKey(itemId)) }
        return Attempt.Finished(RepositoryResult.Failure(FailureKind.NOT_FOUND))
    }

    /** Reads the server's text of [page] and merges [text] with it against the base; it becomes the new base. */
    private suspend fun rebased(writing: PageWriting, page: KeptPage, text: String): Attempt {
        val remote = writing.sender.send(ApiRequest(HttpMethod.Get, pagePath(page.itemId)))
        state.answered(remote)
        val read = remote as? ApiResponse.Success
        val version = read?.etag
        return when {
            read != null && version != null -> {
                val next = NoteMerge.merge(page.base.orEmpty(), text, read.body)
                val rebased = page.copy(base = read.body, etag = version, local = next)
                store.pages.keep(writing.account, rebased)
                Attempt.Rebased(rebased, next)
            }
            remote.waits() -> Attempt.Waits
            remote.isGone() -> gone(writing.account, page.itemId)
            else -> Attempt.Finished(RepositoryResult.Failure(remote.failureKind()))
        }
    }

    private suspend fun send(sender: QueueSender, itemId: String, markdown: String, etag: String): ApiResponse {
        val request = ApiRequest(
            HttpMethod.Put,
            pagePath(itemId),
            body = markdown,
            extraHeaders = listOf("If-Match" to etag),
            bodyContentType = MARKDOWN,
        )
        return sender.send(request).also { state.answered(it) }
    }

    /** What one write of a page did: saved [Saved.text], waits for the server, ended, or rebased onto the server's. */
    private sealed interface Attempt {
        class Saved(val etag: String, val text: String) : Attempt

        data object Waits : Attempt

        class Finished(val result: RepositoryResult<PageWrite>) : Attempt

        class Rebased(val page: KeptPage, val text: String) : Attempt
    }
}

/** What the device holds of this page with [text] on it, answered to a writer that sent [sent]. */
private fun KeptPage.held(text: String, sent: String): PageWrite =
    if (text == sent) PageWrite.Kept else PageWrite.Merged(etag.orEmpty(), text)

/** The server's id of [itemId] once the queue has answered the write that made it, else [itemId] itself. */
private fun QueueState?.serverIdOf(itemId: String): String = this?.ids?.get(itemId) ?: itemId

/** Whether [itemId] is an id the device made for a write that still waits for the server. */
private fun QueueState?.waitsFor(itemId: String): Boolean = this?.writes.orEmpty().any { it.newId == itemId }

private fun pagePath(itemId: String) = "/api/items/$itemId/page.md"

private fun pageKey(itemId: String) = "page.md\n$itemId"

/** No answer, a server error or a throttle: what can be written later. */
private fun ApiResponse.waits(): Boolean =
    this is ApiResponse.Failure && (status == null || kind == FailureKind.UNAVAILABLE)

/** A refusal because the version written against is not the page's any more. */
private fun ApiResponse.isStale(): Boolean =
    this is ApiResponse.Failure && (status == CONFLICT_STATUS || status == PRECONDITION_FAILED_STATUS)

/** The server does not have the item of the page (any more). */
private fun ApiResponse.isGone(): Boolean = this is ApiResponse.Failure && status == NOT_FOUND_STATUS

private fun ApiResponse.failureKind(): FailureKind = (this as? ApiResponse.Failure)?.kind ?: FailureKind.INVALID_DATA
