package cz.semprec.app.domain

/** Where a thread sorts in a list: newest [lastMessageAt] first, then the higher [threadId], as the server orders. */
data class MailThreadKey(val lastMessageAt: String, val threadId: String) : Comparable<MailThreadKey> {
    override fun compareTo(other: MailThreadKey): Int =
        compareValuesBy(other, this, MailThreadKey::lastMessageAt, MailThreadKey::threadId)
}

val MailThreadSummary.key: MailThreadKey get() = MailThreadKey(lastMessageAt, threadId)

/**
 * The rows of one thread list view as the device knows them, with the cursors to go on from. [changesCursor] names the
 * server's state the rows show (`null` when the server named none; the list is then read again whole). [nextCursor] continues the list after the last page read; [windowEnd] is the key of
 * that page's last row, and only rows that sort before it belong to the list until the next page is read. Both are
 * `null` once the last page was read.
 */
data class MailThreadList(
    val threads: List<MailThreadSummary>,
    val nextCursor: String?,
    val changesCursor: String?,
    val windowEnd: MailThreadKey?,
)

/**
 * The thread lists the device keeps for the signed-in account, by view ([MailThreadQuery] without its search and
 * cursor), so a list shows before the server answers and when it cannot be reached. What it holds is only ever shown
 * until the server answers; a read that finds nothing usable is `null`.
 */
interface MailThreadListCache {
    suspend fun read(view: MailThreadQuery): MailThreadList?

    suspend fun write(view: MailThreadQuery, list: MailThreadList)

    /** Forgets every list of every account. */
    suspend fun clear()
}

/** A [MailThreadListCache] that keeps nothing; where no cache is wired. */
class NoMailThreadListCache : MailThreadListCache {
    override suspend fun read(view: MailThreadQuery): MailThreadList? = null

    override suspend fun write(view: MailThreadQuery, list: MailThreadList) = Unit

    override suspend fun clear() = Unit
}

/** The view a query names: the list's filters without its search and page cursor. */
fun MailThreadQuery.view(): MailThreadQuery = copy(search = "", cursor = null)

/**
 * Keeps the thread list of a view up to date with the server through the device's [cache]: the kept rows first, then
 * only the changes since them, or the first page when there are none or the server asks for a reset. A search is
 * never kept. Writes stay server calls of [MailRepository]; this only reads, the changes through [changes].
 */
class SyncMailThreadList(
    private val mail: MailRepository,
    private val changes: MailThreadChangesRepository,
    private val cache: MailThreadListCache,
) {
    /** The rows the device kept for the view of [query], or `null` (always for a search). */
    suspend fun cached(query: MailThreadQuery): MailThreadList? =
        if (query.search.isNotBlank()) null else cache.read(query.view())

    /**
     * Brings [shown] (the list of the view of [query], or `null` for none) up to date and keeps the result. With a
     * changes cursor it asks for the changes since then and merges them; without one, or when the server answers a
     * reset, it reads the first page.
     */
    suspend fun refresh(query: MailThreadQuery, shown: MailThreadList?): RepositoryResult<MailThreadList> {
        val view = query.view()
        val since = shown?.changesCursor
        val refreshed = if (shown == null || since == null) {
            firstPage(view)
        } else {
            when (val answer = changes.threadChanges(view, since)) {
                is RepositoryResult.Failure -> answer
                is RepositoryResult.Content ->
                    if (answer.value.reset) firstPage(view) else RepositoryResult.Content(shown.merged(answer.value))
            }
        }
        if (refreshed is RepositoryResult.Content) cache.write(view, refreshed.value)
        return refreshed
    }

    /** The page [page] read with [list]'s next cursor, appended, and kept. */
    suspend fun appended(query: MailThreadQuery, list: MailThreadList, page: MailThreadPage): MailThreadList {
        val known = list.threads.mapTo(HashSet()) { it.threadId }
        val threads = list.threads + page.threads.filter { it.threadId !in known }
        val next = list.copy(
            threads = threads,
            nextCursor = page.nextCursor,
            windowEnd = page.nextCursor?.let { threads.lastOrNull()?.key },
        )
        cache.write(query.view(), next)
        return next
    }

    private suspend fun firstPage(view: MailThreadQuery): RepositoryResult<MailThreadList> =
        when (val page = mail.threads(view)) {
            is RepositoryResult.Failure -> page
            is RepositoryResult.Content -> RepositoryResult.Content(
                MailThreadList(
                    threads = page.value.threads,
                    nextCursor = page.value.nextCursor,
                    changesCursor = page.value.changesCursor,
                    windowEnd = page.value.nextCursor?.let { page.value.threads.lastOrNull()?.key },
                ),
            )
        }
}

/**
 * The list after [changes]: every changed or removed thread leaves, then each changed row in the view comes back in its
 * place by [key]. Before the last page was read, a changed row that sorts after [MailThreadList.windowEnd] stays out,
 * as the next page brings it.
 */
fun MailThreadList.merged(changes: MailThreadChanges): MailThreadList {
    val changed = changes.removed.toHashSet() + changes.threads.map { it.threadId }
    val end = windowEnd
    val incoming = changes.threads.filter { end == null || it.key <= end }
    return copy(
        threads = (threads.filter { it.threadId !in changed } + incoming).sortedBy { it.key },
        changesCursor = changes.cursor,
    )
}
