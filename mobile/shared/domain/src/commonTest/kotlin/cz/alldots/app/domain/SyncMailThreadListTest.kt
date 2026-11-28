package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private fun thread(id: String, at: String, unread: Boolean = true) = MailThreadSummary(
    threadId = id,
    subject = "Re: $id",
    lastMessageAt = at,
    senderName = "Petr Novák",
    senderAddress = "petr@novak.cz",
    senderRelationship = null,
    messageCount = 1,
    preview = null,
    hasAttachment = false,
    unread = unread,
    flagged = false,
    mailboxNames = listOf("Gmail"),
    project = null,
    company = null,
    hasSempDraft = false,
)

private val T1 = thread("t1", "2026-10-21T09:00:00.000000Z")
private val T2 = thread("t2", "2026-10-20T09:00:00.000000Z")
private val T3 = thread("t3", "2026-10-19T09:00:00.000000Z")

/** The thread list calls of the server, each answered from its own list of answers in turn. */
private class ScriptedThreadLists(
    pages: List<RepositoryResult<MailThreadPage>> = emptyList(),
    changes: List<RepositoryResult<MailThreadChanges>> = emptyList(),
) : MailRepository, MailThreadChangesRepository {
    private val pages = ArrayDeque(pages)
    private val changes = ArrayDeque(changes)
    val asked = mutableListOf<String>()

    override suspend fun threads(query: MailThreadQuery): RepositoryResult<MailThreadPage> {
        asked += "page:${query.cursor}"
        return pages.removeFirst()
    }

    override suspend fun threadChanges(query: MailThreadQuery, since: String): RepositoryResult<MailThreadChanges> {
        asked += "changes:$since"
        return changes.removeFirst()
    }

    override suspend fun facets() = error("not asked")
    override suspend fun summary() = error("not asked")
    override suspend fun thread(threadId: String) = error("not asked")
    override suspend fun setRead(threadId: String, read: Boolean) = error("not asked")
    override suspend fun setFlagged(threadId: String, flagged: Boolean) = error("not asked")
    override suspend fun archive(threadId: String) = error("not asked")
    override suspend fun trash(threadId: String) = error("not asked")
    override suspend fun restore(threadId: String) = error("not asked")
    override suspend fun createTask(threadId: String) = error("not asked")
}

private class MemoryThreadLists : MailThreadListCache {
    val kept = mutableMapOf<MailThreadQuery, MailThreadList>()
    val reads = mutableListOf<MailThreadQuery>()

    override suspend fun read(view: MailThreadQuery): MailThreadList? {
        reads += view
        return kept[view]
    }

    override suspend fun write(view: MailThreadQuery, list: MailThreadList) {
        kept[view] = list
    }

    override suspend fun clear() = kept.clear()
}

class SyncMailThreadListTest {
    private val view = MailThreadQuery(box = MailBox.FLAGGED, projectId = "p1")

    private fun complete(vararg threads: MailThreadSummary, cursor: String = "k1") =
        MailThreadList(threads.toList(), nextCursor = null, changesCursor = cursor, windowEnd = null)

    private fun changes(
        vararg threads: MailThreadSummary,
        removed: List<String> = emptyList(),
        cursor: String = "k2",
        reset: Boolean = false,
    ) = MailThreadChanges(cursor, threads.toList(), removed, reset)

    @Test
    fun aChangedRowReplacesItsOldRowInItsNewPlace() {
        val bumped = T3.copy(lastMessageAt = "2026-10-22T09:00:00.000000Z", unread = false)

        val merged = complete(T1, T2, T3).merged(changes(bumped))

        assertEquals(complete(bumped, T1, T2, cursor = "k2"), merged)
    }

    @Test
    fun aNewRowIsInsertedByItsKeyAndARemovedIdLeaves() {
        val between = thread("t9", "2026-10-20T12:00:00.000000Z")

        val merged = complete(T1, T2, T3).merged(changes(between, removed = listOf("t1", "unknown")))

        assertEquals(listOf("t9", "t2", "t3"), merged.threads.map { it.threadId })
        assertEquals("k2", merged.changesCursor)
    }

    @Test
    fun rowsOfTheSameTimeSortByTheHigherThreadIdFirst() {
        val same = T2.copy(threadId = "t5")

        assertEquals(listOf("t1", "t5", "t2"), complete(T1, T2).merged(changes(same)).threads.map { it.threadId })
    }

    @Test
    fun beforeTheLastPageAChangedRowAfterTheWindowStaysForTheNextPage() {
        val window = MailThreadList(listOf(T1, T2), nextCursor = "n1", changesCursor = "k1", windowEnd = T2.key)
        val older = thread("t0", "2026-10-01T09:00:00.000000Z")
        val movedBack = T1.copy(lastMessageAt = "2026-10-02T09:00:00.000000Z")

        val merged = window.merged(changes(older, movedBack))

        assertEquals(listOf("t2"), merged.threads.map { it.threadId })
        assertEquals("n1", merged.nextCursor)
        assertEquals(T2.key, merged.windowEnd)
    }

    @Test
    fun withoutAKeptListTheFirstPageIsReadAndKept() = runTest {
        val server = ScriptedThreadLists(
            pages = listOf(RepositoryResult.Content(MailThreadPage(listOf(T1, T2), "n1", "k1"))),
        )
        val cache = MemoryThreadLists()
        val lists = SyncMailThreadList(server, server, cache)

        val answer = lists.refresh(view.copy(search = "", cursor = "x"), shown = null)

        val expected = MailThreadList(listOf(T1, T2), nextCursor = "n1", changesCursor = "k1", windowEnd = T2.key)
        assertEquals(RepositoryResult.Content(expected), answer)
        assertEquals(listOf("page:null"), server.asked)
        assertEquals(mapOf(view to expected), cache.kept)
    }

    @Test
    fun aKeptListAsksOnlyForTheChangesSinceItsCursorAndKeepsTheMerge() = runTest {
        val read = T1.copy(unread = false)
        val server =
            ScriptedThreadLists(changes = listOf(RepositoryResult.Content(changes(read, removed = listOf("t2")))))
        val cache = MemoryThreadLists()

        val answer = SyncMailThreadList(server, server, cache).refresh(view, complete(T1, T2, T3))

        assertEquals(RepositoryResult.Content(complete(read, T3, cursor = "k2")), answer)
        assertEquals(listOf("changes:k1"), server.asked)
        assertEquals(complete(read, T3, cursor = "k2"), cache.kept[view])
    }

    @Test
    fun aResetReadsTheFirstPageAgainInsteadOfMerging() = runTest {
        val server = ScriptedThreadLists(
            pages = listOf(RepositoryResult.Content(MailThreadPage(listOf(T3), null, "k9"))),
            changes = listOf(RepositoryResult.Content(changes(cursor = "k5", reset = true))),
        )
        val cache = MemoryThreadLists()

        val answer = SyncMailThreadList(server, server, cache).refresh(view, complete(T1, T2))

        assertEquals(RepositoryResult.Content(complete(T3, cursor = "k9")), answer)
        assertEquals(listOf("changes:k1", "page:null"), server.asked)
        assertEquals(complete(T3, cursor = "k9"), cache.kept[view])
    }

    @Test
    fun aListWithoutAChangesCursorIsReadWhole() = runTest {
        val server = ScriptedThreadLists(pages = listOf(RepositoryResult.Content(MailThreadPage(listOf(T2), null))))

        val answer = SyncMailThreadList(server, server, MemoryThreadLists())
            .refresh(view, MailThreadList(listOf(T1), null, changesCursor = null, windowEnd = null))

        assertEquals(RepositoryResult.Content(MailThreadList(listOf(T2), null, null, null)), answer)
        assertEquals(listOf("page:null"), server.asked)
    }

    @Test
    fun aFailureKeepsNothingAndIsAnswered() = runTest {
        val server = ScriptedThreadLists(changes = listOf(RepositoryResult.Failure(FailureKind.UNAVAILABLE)))
        val cache = MemoryThreadLists()

        val answer = SyncMailThreadList(server, server, cache).refresh(view, complete(T1))

        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), answer)
        assertEquals(emptyMap(), cache.kept)
    }

    @Test
    fun aSearchIsNeitherReadFromNorKeptInTheCache() = runTest {
        val cache = MemoryThreadLists().apply { kept[MailThreadQuery()] = complete(T1) }
        val lists = ScriptedThreadLists().let { SyncMailThreadList(it, it, cache) }

        assertNull(lists.cached(MailThreadQuery(search = "faktura")))
        assertEquals(complete(T1), lists.cached(MailThreadQuery(cursor = "c3")))
        assertEquals(listOf(MailThreadQuery()), cache.reads)
    }

    @Test
    fun aNextPageIsAppendedWithoutRepeatsAndMovesTheWindow() = runTest {
        val cache = MemoryThreadLists()
        val window = MailThreadList(listOf(T1, T2), nextCursor = "n1", changesCursor = "k1", windowEnd = T2.key)

        val more = ScriptedThreadLists().let { SyncMailThreadList(it, it, cache) }
            .appended(view.copy(cursor = "n1"), window, MailThreadPage(listOf(T2, T3), nextCursor = null))

        val expected = MailThreadList(listOf(T1, T2, T3), nextCursor = null, changesCursor = "k1", windowEnd = null)
        assertEquals(expected, more)
        assertEquals(more, cache.kept[view])
    }
}
