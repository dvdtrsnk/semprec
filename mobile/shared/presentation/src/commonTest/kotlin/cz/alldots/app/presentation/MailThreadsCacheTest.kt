package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.MailThreadChanges
import cz.alldots.app.domain.MailThreadList
import cz.alldots.app.domain.MailThreadListCache
import cz.alldots.app.domain.MailThreadQuery
import cz.alldots.app.domain.MailThreadSummary
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.domain.SyncTopic
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The thread lists a device keeps, in memory; [reads] and [writes] record what the ViewModel asked for. */
internal class MemoryMailThreadListCache(vararg kept: Pair<MailThreadQuery, MailThreadList>) : MailThreadListCache {
    val kept = mutableMapOf(*kept)
    val reads = mutableListOf<MailThreadQuery>()
    val writes = mutableListOf<Pair<MailThreadQuery, MailThreadList>>()

    override suspend fun read(view: MailThreadQuery): MailThreadList? {
        reads += view
        return kept[view]
    }

    override suspend fun write(view: MailThreadQuery, list: MailThreadList) {
        writes += view to list
        kept[view] = list
    }

    override suspend fun clear() = kept.clear()
}

@OptIn(ExperimentalCoroutinesApi::class)
class MailThreadsCacheTest : MainDispatcherTest() {
    private val sync = SyncChanges()

    private fun viewModel(mail: ScriptedMailRepository, cache: MemoryMailThreadListCache) = MailViewModelFactory(
        mail,
        mail,
        ScriptedMailDraftRepository(),
        ScriptedMailboxRepository(),
        mail,
        mail,
        sync = sync,
        threadLists = cache,
    ).threadsViewModel(MailListStart())

    private val kept = MailThreadList(
        threads = listOf(mailThread("t1"), mailThread("t2", sender = "Jana")),
        nextCursor = null,
        changesCursor = "k1",
        windowEnd = null,
    )

    private fun changes(vararg rows: MailThreadSummary, removed: List<String> = emptyList()) =
        MailThreadChanges("k2", rows.toList(), removed, reset = false)

    @Test fun `shows the kept rows first and then merges only the changes since them and keeps the result`() =
        runTest(dispatcher) {
            val answer = CompletableDeferred<Unit>()
            val mail = ScriptedMailRepository(
                changes = MailCall({
                    answer.await()
                    RepositoryResult.Content(changes(mailThread("t1", unread = false), removed = listOf("t2")))
                }),
            )
            val cache = MemoryMailThreadListCache(MailThreadQuery() to kept)
            val vm = viewModel(mail, cache)
            runCurrent()

            val first = vm.state.value
            assertEquals(MailThreadsPhase.CONTENT, first.phase)
            assertTrue(first.fromCache && first.refreshing)
            assertEquals(listOf("t1", "t2"), first.threads.map { it.threadId })

            answer.complete(Unit)
            runCurrent()

            val second = vm.state.value
            assertFalse(second.fromCache || second.refreshing || second.actionFailed)
            assertEquals(listOf("t1"), second.threads.map { it.threadId })
            assertFalse(second.threads.single().unread)
            assertEquals(listOf(MailThreadQuery() to "k1"), mail.changes.asked)
            assertEquals(0, mail.threads.count)
            val merged = kept.copy(threads = listOf(mailThread("t1", unread = false)), changesCursor = "k2")
            assertEquals(listOf(MailThreadQuery() to merged), cache.writes)
            vm.close()
        }

    @Test fun `without kept rows the first page is read and kept with its cursors`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(threads = MailCall(mailContent(mailPage(next = "n1", changesCursor = "k1"))))
        val cache = MemoryMailThreadListCache()
        val vm = viewModel(mail, cache)
        runCurrent()

        assertFalse(vm.state.value.fromCache)
        assertEquals(listOf("t1"), vm.state.value.threads.map { it.threadId })
        val (view, list) = cache.writes.single()
        assertEquals(MailThreadQuery(), view)
        assertEquals("k1", list.changesCursor)
        assertEquals("n1", list.nextCursor)
        assertEquals(0, mail.changes.count)

        vm.onAction(MailThreadsAction.Refresh)
        runCurrent()
        assertEquals(listOf(MailThreadQuery() to "k1"), mail.changes.asked)
        vm.close()
    }

    @Test fun `offline the kept rows stay with the failure banner`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(changes = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val cache = MemoryMailThreadListCache(MailThreadQuery() to kept)
        val vm = viewModel(mail, cache)
        runCurrent()

        val state = vm.state.value
        assertEquals(MailThreadsPhase.CONTENT, state.phase)
        assertTrue(state.fromCache && state.actionFailed)
        assertFalse(state.refreshing)
        assertNull(state.failure)
        assertEquals(listOf("t1", "t2"), state.threads.map { it.threadId })
        assertTrue(cache.writes.isEmpty())
        vm.close()
    }

    @Test fun `offline without kept rows the list is an error`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(threads = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(mail, MemoryMailThreadListCache())
        runCurrent()

        assertEquals(MailThreadsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        vm.close()
    }

    @Test fun `a change the server reports refreshes the list once it has been quiet`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(changes = MailCall(mailContent(changes(mailThread("t3")))))
        val vm = viewModel(mail, MemoryMailThreadListCache(MailThreadQuery() to kept))
        runCurrent()
        assertEquals(1, mail.changes.count)

        sync.raise(setOf(SyncTopic.MAIL_THREADS))
        runCurrent()
        advanceTimeBy(REMOTE_REFRESH_DELAY_MILLIS / 2)
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        advanceTimeBy(REMOTE_REFRESH_DELAY_MILLIS - 1)
        runCurrent()
        assertEquals(1, mail.changes.count)

        advanceTimeBy(2)
        runCurrent()
        assertEquals(listOf(MailThreadQuery() to "k1", MailThreadQuery() to "k2"), mail.changes.asked)
        assertEquals(listOf("t3", "t1", "t2").sorted(), vm.state.value.threads.map { it.threadId }.sorted())

        sync.raise(setOf(SyncTopic.CALENDAR))
        advanceTimeBy(REMOTE_REFRESH_DELAY_MILLIS * 2)
        runCurrent()
        assertEquals(2, mail.changes.count)
        vm.close()
    }

    @Test fun `a search reads and keeps no rows and a reported change does not repeat it`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val cache = MemoryMailThreadListCache(MailThreadQuery() to kept)
        val vm = viewModel(mail, cache)
        runCurrent()
        val writes = cache.writes.size

        vm.onAction(MailThreadsAction.Search("faktura"))
        runCurrent()
        sync.raise(setOf(SyncTopic.MAIL_THREADS))
        advanceTimeBy(REMOTE_REFRESH_DELAY_MILLIS * 2)
        runCurrent()

        assertFalse(vm.state.value.fromCache)
        assertEquals(listOf(MailThreadQuery()), cache.reads)
        assertEquals(writes, cache.writes.size)
        assertEquals(1, mail.searches.count)
        vm.close()
    }
}
