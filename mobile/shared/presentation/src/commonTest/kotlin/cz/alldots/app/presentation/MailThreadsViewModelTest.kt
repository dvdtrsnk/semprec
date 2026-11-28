package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailRefusal
import cz.alldots.app.domain.MailBox
import cz.alldots.app.domain.MailSyncStatus
import cz.alldots.app.domain.MailThreadQuery
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class MailThreadsViewModelTest : MainDispatcherTest() {
    private fun viewModel(
        mail: ScriptedMailRepository = ScriptedMailRepository(),
        mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository(),
        start: MailListStart = MailListStart(),
    ) = MailViewModelFactory(mail, mail, ScriptedMailDraftRepository(), mailboxes, mail, mail).threadsViewModel(start)

    @Test fun `starts loading and publishes the rows the server listed`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedMailRepository(threads = MailCall(mailContent(mailPage(next = "c1")))))
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(MailThreadsPhase.CONTENT, state.phase)
        assertTrue(state.hasMore)
        val row = state.threads.single()
        assertEquals("t1", row.threadId)
        assertEquals("Petr Novák", row.senderName)
        assertEquals("Klient", row.senderRelationship)
        assertEquals("Web", row.projectName)
        assertTrue(row.unread && row.hasSempDraft && row.hasAttachment)
        vm.close()
    }

    @Test fun `the start decides the first query`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val start = MailListStart("pr1", MailListBox.SEMP_DRAFTS, "m1", "f1")
        val vm = viewModel(mail, start = start)
        runCurrent()
        val expected = MailThreadQuery(MailBox.SEMP_DRAFTS, "m1", "f1", "pr1")
        assertEquals(expected, mail.threads.asked.single())
        assertEquals(1, mail.facets.count)
        vm.close()
    }

    @Test fun `filters and search change the query and reload behind a wait`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.SelectFilter(MailListFilter.UNREAD))
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        vm.onAction(MailThreadsAction.SelectFilter(MailListFilter.FLAGGED))
        runCurrent()
        vm.onAction(MailThreadsAction.SelectFilter(MailListFilter.ALL))
        vm.onAction(MailThreadsAction.Search("  from:petr "))
        runCurrent()
        vm.onAction(MailThreadsAction.SelectMailbox("m1"))
        runCurrent()
        assertEquals(
            listOf(
                MailThreadQuery(),
                MailThreadQuery(unreadOnly = true),
                MailThreadQuery(box = MailBox.FLAGGED),
            ),
            mail.threads.asked,
        )
        assertEquals(listOf("from:petr" to null, "from:petr" to "m1"), mail.searches.asked)
        vm.close()
    }

    @Test fun `a search lists what the mail search found with what the providers added`() = runTest(dispatcher) {
        val found = mailSearch(mailThread("t7"), mailThread("t8"), failed = listOf("m1", "m9"), unindexed = 12)
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage(next = "c1"))),
            searches = MailCall(mailContent(found)),
        )
        val vm = viewModel(mail)
        runCurrent()
        assertNull(vm.state.value.remoteSearch)
        vm.onAction(MailThreadsAction.Search("faktura"))
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(MailThreadsPhase.CONTENT, state.phase)
        assertEquals(listOf("t7", "t8"), state.threads.map { it.threadId })
        assertFalse(state.hasMore)
        assertEquals(
            MailRemoteSearchSummary(12, listOf(MailMailboxChip("m1", "Gmail"), MailMailboxChip("m9", ""))),
            state.remoteSearch,
        )
        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        assertEquals(1, mail.threads.count)
        vm.onAction(MailThreadsAction.Search(""))
        runCurrent()
        assertNull(vm.state.value.remoteSearch)
        assertEquals(2, mail.threads.count)
        vm.close()
    }

    @Test fun `a failed provider search names its mailbox once the mailboxes are known`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val mailboxes = ScriptedMailboxRepository(
            list = MailCall(answersLate(gate, RepositoryResult.Content(listOf(mailAccount("m2"))))),
        )
        val mail = ScriptedMailRepository(searches = MailCall(mailContent(mailSearch(failed = listOf("m2")))))
        val vm = viewModel(mail, mailboxes)
        vm.onAction(MailThreadsAction.Search("x"))
        runCurrent()
        assertEquals(listOf(MailMailboxChip("m2", "")), vm.state.value.remoteSearch?.failedAccounts)
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf(MailMailboxChip("m2", "Gmail")), vm.state.value.remoteSearch?.failedAccounts)
        vm.close()
    }

    @Test fun `a failed search is an error and a failed refresh of a search keeps what it found`() =
        runTest(dispatcher) {
            val mail = ScriptedMailRepository(
                searches = MailCall(
                    mailFailure(FailureKind.UNAVAILABLE),
                    mailContent(mailSearch(unindexed = 3)),
                    mailFailure(FailureKind.UNAVAILABLE),
                ),
            )
            val vm = viewModel(mail)
            runCurrent()
            vm.onAction(MailThreadsAction.Search("x"))
            runCurrent()
            assertEquals(MailThreadsPhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
            vm.onAction(MailThreadsAction.Retry)
            runCurrent()
            assertEquals(3, vm.state.value.remoteSearch?.unindexed)
            vm.onAction(MailThreadsAction.Refresh)
            runCurrent()
            assertEquals(MailThreadsPhase.CONTENT, vm.state.value.phase)
            assertTrue(vm.state.value.actionFailed)
            assertEquals(3, vm.state.value.remoteSearch?.unindexed)
            assertEquals(3, mail.searches.count)
            vm.close()
        }

    @Test fun `choosing the chosen mailbox again clears it and an unchanged search loads nothing`() =
        runTest(dispatcher) {
            val mail = ScriptedMailRepository()
            val vm = viewModel(mail)
            runCurrent()
            vm.onAction(MailThreadsAction.SelectMailbox("m1"))
            runCurrent()
            vm.onAction(MailThreadsAction.SelectMailbox("m1"))
            runCurrent()
            assertNull(vm.state.value.mailboxId)
            val calls = mail.threads.count
            vm.onAction(MailThreadsAction.Search(""))
            runCurrent()
            assertEquals(calls, mail.threads.count)
            vm.close()
        }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailFailure(FailureKind.UNAUTHORIZED), mailContent(mailPage())),
        )
        val vm = viewModel(mail)
        runCurrent()
        assertEquals(MailThreadsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
        vm.onAction(MailThreadsAction.Retry)
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(MailThreadsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedMailRepository(threads = MailCall(crashes())))
        runCurrent()
        assertEquals(MailThreadsPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a refresh keeps the rows and a failed one says so until dismissed`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage()), mailFailure(FailureKind.UNAVAILABLE)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.Refresh)
        assertTrue(vm.state.value.refreshing)
        assertEquals(1, vm.state.value.threads.size)
        runCurrent()
        assertFalse(vm.state.value.refreshing)
        assertTrue(vm.state.value.actionFailed)
        assertEquals(1, vm.state.value.threads.size)
        vm.onAction(MailThreadsAction.DismissFailure)
        assertFalse(vm.state.value.actionFailed)
        vm.close()
    }

    @Test fun `a refresh without rows is a retry`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailFailure(FailureKind.UNAVAILABLE), mailContent(mailPage())),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.Refresh)
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(MailThreadsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `more rows are appended after the cursor and a repeated thread is kept once`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(
                mailContent(mailPage(mailThread("a"), mailThread("b"), next = "c1")),
                mailContent(mailPage(mailThread("b"), mailThread("c"))),
            ),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.LoadMore)
        assertTrue(vm.state.value.loadingMore)
        runCurrent()
        assertEquals(listOf("a", "b", "c"), vm.state.value.threads.map { it.threadId })
        assertFalse(vm.state.value.hasMore)
        assertFalse(vm.state.value.loadingMore)
        assertEquals("c1", mail.threads.asked.last().cursor)
        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        assertEquals(2, mail.threads.count)
        vm.close()
    }

    @Test fun `a failed page leaves the rows and raises the failure`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage(next = "c1")), mailFailure(FailureKind.UNAVAILABLE)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        assertEquals(1, vm.state.value.threads.size)
        assertFalse(vm.state.value.loadingMore)
        assertTrue(vm.state.value.actionFailed)
        assertTrue(vm.state.value.hasMore)
        vm.close()
    }

    @Test fun `a page is not requested while a load runs`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(threads = MailCall(mailContent(mailPage(next = "c1")), neverAnswers()))
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        assertEquals(2, mail.threads.count)
        vm.close()
    }

    @Test fun `a superseded load that answers late never overwrites the newer list`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val mail = ScriptedMailRepository(
            threads = MailCall(
                answersLate(gate, RepositoryResult.Failure(FailureKind.UNAVAILABLE)),
                mailContent(mailPage(mailThread("fresh"))),
            ),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(MailThreadsPhase.CONTENT, vm.state.value.phase)
        assertEquals(listOf("fresh"), vm.state.value.threads.map { it.threadId })
        vm.close()
    }

    @Test fun `marking read shows at once and keeps the answer of the server`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage(mailThread("a", unread = true)))),
            read = MailCall(mailDone(false)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.ToggleRead("a"))
        assertFalse(vm.state.value.threads.single().unread)
        runCurrent()
        assertFalse(vm.state.value.threads.single().unread)
        assertEquals(listOf("a" to true), mail.read.asked)
        vm.close()
    }

    @Test fun `a read mark stays when the next page comes and so does one set while it loaded`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val mail = ScriptedMailRepository(
            threads = MailCall(
                mailContent(mailPage(mailThread("a", unread = true), mailThread("b", unread = true), next = "c1")),
                mailContent(mailPage(mailThread("c", unread = true), next = "c2")),
                answersLate(gate, RepositoryResult.Content(mailPage(mailThread("d", unread = true)))),
            ),
            read = MailCall(mailDone(false), mailDone(false)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.ToggleRead("a"))
        runCurrent()
        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        assertEquals(
            listOf("a" to false, "b" to true, "c" to true),
            vm.state.value.threads.map { it.threadId to it.unread },
        )

        vm.onAction(MailThreadsAction.LoadMore)
        runCurrent()
        vm.onAction(MailThreadsAction.ToggleRead("b"))
        runCurrent()
        gate.complete(Unit)
        runCurrent()

        assertEquals(
            listOf("a" to false, "b" to false, "c" to true, "d" to true),
            vm.state.value.threads.map { it.threadId to it.unread },
        )
        vm.close()
    }

    @Test fun `marking unread asks for read false and a refused write puts the dot back`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage(mailThread("a", unread = false)))),
            read = MailCall(mailFailure(FailureKind.REJECTED)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.ToggleRead("a"))
        assertTrue(vm.state.value.threads.single().unread)
        runCurrent()
        assertFalse(vm.state.value.threads.single().unread)
        assertTrue(vm.state.value.actionFailed)
        assertEquals(listOf("a" to false), mail.read.asked)
        vm.onAction(MailThreadsAction.ToggleRead("unknown"))
        runCurrent()
        assertEquals(1, mail.read.count)
        vm.close()
    }

    @Test fun `an unread mark refused for a thread without a received message says why`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage(mailThread("a", unread = false)))),
            read = MailCall(mailRefused(MailRefusal.NO_RECEIVED_MESSAGE)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadsAction.ToggleRead("a"))
        runCurrent()
        assertFalse(vm.state.value.threads.single().unread)
        assertTrue(vm.state.value.actionFailed)
        assertEquals(MailRefusal.NO_RECEIVED_MESSAGE, vm.state.value.actionRefusal)
        vm.onAction(MailThreadsAction.DismissFailure)
        assertFalse(vm.state.value.actionFailed)
        assertNull(vm.state.value.actionRefusal)
        vm.close()
    }

    @Test fun `the facets fill the sheet and name the project the list starts with`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail, start = MailListStart(projectId = "pr1"))
        runCurrent()
        val state = vm.state.value
        assertEquals("pr1", state.projectId)
        assertEquals("Web", state.projectName)
        assertEquals(
            MailFacetsState(
                phase = MailFacetsPhase.READY,
                projectTotal = 7,
                projects = listOf(
                    MailFilterOption("pr1", "Web", "#FF9500", 3),
                    MailFilterOption("pr2", "Koupelna", null, 2),
                ),
            ),
            state.facets,
        )
        vm.close()
    }

    @Test fun `a project without threads that the list starts with is named from the projects`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(projectNames = MailCall(mailContent("Zahrada")))
        val vm = viewModel(mail, start = MailListStart(projectId = "quiet"))
        runCurrent()
        assertEquals(listOf("quiet"), mail.projectNames.asked)
        assertEquals(MailFacetsPhase.READY, vm.state.value.facets.phase)
        assertEquals("Zahrada", vm.state.value.projectName)
        vm.close()
    }

    @Test fun `a list without a project names none and asks for no name`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(projectNames = MailCall(mailContent("Zahrada")))
        val vm = viewModel(mail)
        runCurrent()
        assertTrue(mail.projectNames.asked.isEmpty())
        assertNull(vm.state.value.projectName)
        vm.close()
    }

    @Test fun `a failed or empty project name keeps the name of the facet options`() = runTest(dispatcher) {
        for (answer in listOf(mailFailure<String?>(FailureKind.UNAVAILABLE), mailContent<String?>(null))) {
            val mail = ScriptedMailRepository(projectNames = MailCall(answer))
            val vm = viewModel(mail, start = MailListStart(projectId = "pr1"))
            runCurrent()
            assertEquals("Web", vm.state.value.projectName)
            vm.close()
        }
    }

    @Test fun `a project name that answers after the context changed is not shown`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val mail = ScriptedMailRepository(
            projectNames = MailCall(answersLate(gate, RepositoryResult.Content<String?>("Zahrada"))),
        )
        val vm = viewModel(mail, start = MailListStart(projectId = "quiet"))
        runCurrent()
        vm.onAction(MailThreadsAction.ClearContext)
        gate.complete(Unit)
        runCurrent()
        assertNull(vm.state.value.projectId)
        assertNull(vm.state.value.projectName)
        vm.close()
    }

    @Test fun `a project is chosen by name and clearing the context reads everything`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail, start = MailListStart(projectId = "pr2"))
        runCurrent()
        vm.onAction(MailThreadsAction.SetProject("pr1"))
        assertEquals("Web", vm.state.value.projectName)
        assertEquals("pr1", vm.state.value.projectId)
        runCurrent()
        vm.onAction(MailThreadsAction.SetProject(null))
        assertNull(vm.state.value.projectId)
        assertNull(vm.state.value.projectName)
        runCurrent()
        assertEquals(1, mail.facets.count)
        vm.onAction(MailThreadsAction.SetProject("pr2"))
        vm.onAction(MailThreadsAction.ClearContext)
        assertNull(vm.state.value.projectId)
        runCurrent()
        assertEquals(MailThreadQuery(), mail.threads.asked.last())
        vm.close()
    }

    @Test fun `failed facets leave the list and mark the sheet`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(facets = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(mail)
        runCurrent()
        assertEquals(MailFacetsPhase.ERROR, vm.state.value.facets.phase)
        assertEquals(MailThreadsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `the mailboxes become chips and the ones needing a sign in a notice`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(
            list = MailCall(
                mailContent(
                    listOf(mailAccount("m1"), mailAccount("m2", status = MailSyncStatus.NEEDS_REAUTHORIZATION)),
                ),
            ),
        )
        val vm = viewModel(mailboxes = boxes)
        runCurrent()
        assertEquals(listOf("m1", "m2"), vm.state.value.mailboxes.map { it.id })
        val notice = MailAccountNotice("m2", "Gmail", "2026-10-19T09:12:00.000Z")
        assertEquals(listOf(notice), vm.state.value.reauthorization)
        vm.close()
    }

    @Test fun `mailboxes that cannot be read leave the list without chips`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(list = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(mailboxes = boxes)
        runCurrent()
        assertEquals(emptyList(), vm.state.value.mailboxes)
        assertEquals(MailThreadsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `opening raises the target exactly once`() = runTest(dispatcher) {
        val vm = viewModel()
        val received = collectEffects(vm)
        val targets = listOf(
            MailThreadsEffect.OpenThread("t1"),
            MailThreadsEffect.OpenFolders,
            MailThreadsEffect.Compose,
            MailThreadsEffect.OpenAccount("m1"),
        )
        targets.forEach { vm.onAction(MailThreadsAction.Open(it)) }
        runCurrent()
        assertEquals(targets, received)
        vm.close()
    }

    @Test fun `close cancels in flight work without a failure state and is idempotent`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(threads = MailCall(neverAnswers()))
        val vm = viewModel(mail)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, mail.threads.cancellations)
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail)
        runCurrent()
        vm.close()
        vm.onAction(MailThreadsAction.Retry)
        vm.onAction(MailThreadsAction.SelectFilter(MailListFilter.UNREAD))
        vm.onAction(MailThreadsAction.Open(MailThreadsEffect.Compose))
        runCurrent()
        assertEquals(1, mail.threads.count)
        assertEquals(MailListFilter.ALL, vm.state.value.filter)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `a load that answers late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val mail = ScriptedMailRepository(threads = MailCall(answersLate(gate, RepositoryResult.Content(mailPage()))))
        val vm = viewModel(mail)
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(MailThreadsPhase.LOADING, vm.state.value.phase)
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val mail = ScriptedMailRepository(threads = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(mail) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, mail.threads.cancellations)
        vm.onAction(MailThreadsAction.Retry)
        assertEquals(1, mail.threads.count)
    }

    @Test fun `a write elsewhere in the window reads the threads again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val mail = ScriptedMailRepository(
            threads = MailCall(mailContent(mailPage()), mailContent(mailPage(mailThread(id = "t2")))),
        )
        val drafts = ScriptedMailDraftRepository()
        val vm = MailViewModelFactory(mail, mail, drafts, ScriptedMailboxRepository(), mail, mail, changes)
            .threadsViewModel(MailListStart())
        runCurrent()
        changes.emit(Unit)
        runCurrent()
        assertEquals(2, mail.threads.count)
        assertEquals(listOf("t2"), vm.state.value.threads.map { it.threadId })
        vm.close()
    }
}
