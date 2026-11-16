package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.AccountRestoreStatus
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AccountRestoreResult
import cz.semprec.app.domain.AccountTrashDatabase
import cz.semprec.app.domain.AccountTrashItem
import cz.semprec.app.domain.AccountTrashPage
import cz.semprec.app.domain.AccountTrashRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val TASK = AccountTrashItem("i1", "Vyměnit žárovku", "tasks", "Úkoly", "2026-10-21T10:00:00Z", 30)
private val FILE = AccountTrashItem("i2", "scan.pdf", "files", "Soubory", "2026-10-09T10:00:00Z", 18)
private val MORE = AccountTrashItem("i3", "Starý web", "projects", "Projekty", "2026-09-25T10:00:00Z", 4)
private val RECIPES = AccountTrashDatabase("d1", "Recepty", 42, "2026-10-18T10:00:00Z", 27)

private fun row(item: AccountTrashItem) =
    TrashItemRow(item.id, item.title, item.databaseKey, item.databaseName, item.deletedAt, item.daysLeft)

private class ScriptedTrash(
    items: List<ScriptedStep<AccountTrashPage>> = listOf({
        RepositoryResult.Content(AccountTrashPage(listOf(TASK, FILE), 3, "c1"))
    }),
    databases: List<ScriptedStep<List<AccountTrashDatabase>>> = listOf({ RepositoryResult.Content(listOf(RECIPES)) }),
    private val restore: ScriptedStep<List<AccountRestoreResult>> = {
        RepositoryResult.Content(listOf(AccountRestoreResult("i1", AccountRestoreStatus.RESTORED)))
    },
) : AccountTrashRepository {
    val itemCalls = CallScript(items)
    val databaseCalls = CallScript(databases)
    val cursors = mutableListOf<String?>()
    val restored = mutableListOf<Pair<List<String>, List<String>>>()

    override suspend fun items(cursor: String?): RepositoryResult<AccountTrashPage> {
        cursors += cursor
        return itemCalls.next()
    }

    override suspend fun databases() = databaseCalls.next()

    override suspend fun restore(
        itemIds: List<String>,
        databaseIds: List<String>,
    ): RepositoryResult<List<AccountRestoreResult>> {
        restored += itemIds to databaseIds
        return restore()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class TrashViewModelTest : MainDispatcherTest() {
    private fun viewModel(trash: ScriptedTrash) =
        AccountViewModelFactory(
            AccountUnusedAccount,
            AccountUnusedNotifications,
            AccountUnusedUsage,
            trash,
            FakeAuthRepository(),
        ).trashViewModel()

    private suspend fun kotlinx.coroutines.test.TestScope.effectsOf(vm: TrashViewModel): List<TrashEffect> {
        val received = mutableListOf<TrashEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        return received
    }

    @Test fun `loads the deleted items first`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedTrash())
        assertEquals(TrashState(), vm.state.value)
        runCurrent()
        assertEquals(
            TrashState(TrashPhase.CONTENT, items = listOf(row(TASK), row(FILE)), totalItems = 3, hasMore = true),
            vm.state.value,
        )
        vm.close()
    }

    @Test fun `an empty trash is content with no rows`() = runTest(dispatcher) {
        val trash = ScriptedTrash(items = listOf({ RepositoryResult.Content(AccountTrashPage(emptyList(), 0, null)) }))
        val vm = viewModel(trash)
        runCurrent()
        assertEquals(TrashState(TrashPhase.CONTENT), vm.state.value)
        vm.close()
    }

    @Test fun `a failed load is an error with its kind and retry loads the open tab again`() = runTest(dispatcher) {
        val trash = ScriptedTrash(
            items = listOf({
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }, { RepositoryResult.Content(AccountTrashPage(listOf(TASK), 1, null)) }),
        )
        val vm = viewModel(trash)
        runCurrent()
        assertEquals(TrashState(TrashPhase.ERROR, FailureKind.UNAVAILABLE), vm.state.value)
        vm.onAction(TrashAction.Retry)
        assertEquals(TrashState(), vm.state.value)
        runCurrent()
        assertEquals(listOf(row(TASK)), vm.state.value.items)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind in both lists`() = runTest(dispatcher) {
        val trash = ScriptedTrash(items = listOf(crashes()), databases = listOf(crashes()))
        val vm = viewModel(trash)
        runCurrent()
        assertEquals(TrashState(TrashPhase.ERROR, null), vm.state.value)
        vm.onAction(TrashAction.SelectTab(TrashTab.DATABASES))
        runCurrent()
        assertEquals(TrashState(TrashPhase.ERROR, null, tab = TrashTab.DATABASES), vm.state.value)
        vm.close()
    }

    @Test fun `the databases tab reads the deleted databases and going back reads the items again`() =
        runTest(dispatcher) {
            val trash = ScriptedTrash()
            val vm = viewModel(trash)
            runCurrent()
            vm.onAction(TrashAction.SelectTab(TrashTab.DATABASES))
            assertEquals(TrashState(tab = TrashTab.DATABASES), vm.state.value)
            runCurrent()
            assertEquals(
                TrashState(
                    TrashPhase.CONTENT,
                    tab = TrashTab.DATABASES,
                    databases = listOf(TrashDatabaseRow("d1", "Recepty", 42, "2026-10-18T10:00:00Z", 27)),
                ),
                vm.state.value,
            )
            vm.onAction(TrashAction.SelectTab(TrashTab.DATABASES))
            runCurrent()
            assertEquals(1, trash.databaseCalls.calls)
            vm.onAction(TrashAction.SelectTab(TrashTab.ITEMS))
            runCurrent()
            assertEquals(2, trash.itemCalls.calls)
            vm.close()
        }

    @Test fun `more rows are read with the cursor and appended and the last page ends the paging`() =
        runTest(dispatcher) {
            val trash = ScriptedTrash(
                items = listOf(
                    { RepositoryResult.Content(AccountTrashPage(listOf(TASK, FILE), 3, "c1")) },
                    { RepositoryResult.Content(AccountTrashPage(listOf(MORE), 3, null)) },
                ),
            )
            val vm = viewModel(trash)
            runCurrent()
            vm.onAction(TrashAction.LoadMore)
            assertTrue(vm.state.value.loadingMore)
            runCurrent()
            assertEquals(listOf(null, "c1"), trash.cursors)
            assertEquals(listOf(row(TASK), row(FILE), row(MORE)), vm.state.value.items)
            assertEquals(false, vm.state.value.hasMore)
            assertEquals(false, vm.state.value.loadingMore)
            vm.onAction(TrashAction.LoadMore)
            runCurrent()
            assertEquals(2, trash.itemCalls.calls)
            vm.close()
        }

    @Test fun `paging does nothing on the databases tab or while a page is coming`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val trash = ScriptedTrash(
            items = listOf(
                { RepositoryResult.Content(AccountTrashPage(listOf(TASK), 2, "c1")) },
                {
                    gate.await()
                    RepositoryResult.Content(AccountTrashPage(listOf(MORE), 2, null))
                },
            ),
        )
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.LoadMore)
        vm.onAction(TrashAction.LoadMore)
        runCurrent()
        assertEquals(2, trash.itemCalls.calls)
        gate.complete(Unit)
        runCurrent()
        vm.onAction(TrashAction.SelectTab(TrashTab.DATABASES))
        runCurrent()
        vm.onAction(TrashAction.LoadMore)
        runCurrent()
        assertEquals(2, trash.itemCalls.calls)
        vm.close()
    }

    @Test fun `a page that fails keeps the rows and says why`() = runTest(dispatcher) {
        val trash = ScriptedTrash(
            items = listOf(
                { RepositoryResult.Content(AccountTrashPage(listOf(TASK), 2, "c1")) },
                { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            ),
        )
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.LoadMore)
        runCurrent()
        assertEquals(listOf(row(TASK)), vm.state.value.items)
        assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        assertEquals(false, vm.state.value.loadingMore)
        vm.onAction(TrashAction.DismissFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `choosing rows toggles them and selecting all takes every row of the open list`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedTrash())
        runCurrent()
        vm.onAction(TrashAction.ToggleSelecting)
        assertTrue(vm.state.value.selecting)
        vm.onAction(TrashAction.Toggle("i2"))
        vm.onAction(TrashAction.Toggle("nope"))
        assertEquals(listOf("i2"), vm.state.value.selected)
        vm.onAction(TrashAction.Toggle("i2"))
        assertTrue(vm.state.value.selected.isEmpty())
        vm.onAction(TrashAction.SelectAll)
        assertEquals(listOf("i1", "i2"), vm.state.value.selected)
        vm.onAction(TrashAction.ToggleSelecting)
        assertEquals(false, vm.state.value.selecting)
        assertTrue(vm.state.value.selected.isEmpty())
        vm.close()
    }

    @Test fun `restoring one item sends its id and names the collection it came back to`() = runTest(dispatcher) {
        val trash = ScriptedTrash(
            items = listOf(
                { RepositoryResult.Content(AccountTrashPage(listOf(TASK, FILE), 2, null)) },
                { RepositoryResult.Content(AccountTrashPage(listOf(FILE), 1, null)) },
            ),
        )
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.Restore("i1"))
        assertTrue(vm.state.value.working)
        runCurrent()
        assertEquals(listOf(listOf("i1") to emptyList<String>()), trash.restored)
        assertEquals(listOf(row(FILE)), vm.state.value.items)
        assertEquals(false, vm.state.value.working)
        assertEquals(listOf<TrashEffect>(TrashEffect.Restored(1, 0, "Úkoly")), effectsOf(vm))
        vm.close()
    }

    @Test fun `restoring the chosen rows counts what was restored and what the server refused`() =
        runTest(dispatcher) {
            val answer = listOf(
                AccountRestoreResult("i1", AccountRestoreStatus.RESTORED),
                AccountRestoreResult("i2", AccountRestoreStatus.DATABASE_ARCHIVED),
            )
            val trash = ScriptedTrash(restore = { RepositoryResult.Content(answer) })
            val vm = viewModel(trash)
            runCurrent()
            vm.onAction(TrashAction.ToggleSelecting)
            vm.onAction(TrashAction.SelectAll)
            vm.onAction(TrashAction.RestoreSelected)
            runCurrent()
            assertEquals(listOf(listOf("i1", "i2") to emptyList<String>()), trash.restored)
            assertEquals(listOf<TrashEffect>(TrashEffect.Restored(1, 1, "Úkoly")), effectsOf(vm))
            assertEquals(false, vm.state.value.selecting)
            assertTrue(vm.state.value.selected.isEmpty())
            vm.close()
        }

    @Test fun `restoring a database sends its id as a database`() = runTest(dispatcher) {
        val answer = listOf(AccountRestoreResult("d1", AccountRestoreStatus.RESTORED))
        val trash = ScriptedTrash(restore = { RepositoryResult.Content(answer) })
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.SelectTab(TrashTab.DATABASES))
        runCurrent()
        vm.onAction(TrashAction.Restore("d1"))
        runCurrent()
        assertEquals(listOf(emptyList<String>() to listOf("d1")), trash.restored)
        assertEquals(listOf<TrashEffect>(TrashEffect.Restored(1, 0, null)), effectsOf(vm))
        vm.close()
    }

    @Test fun `a restore of nothing or of an unknown row or while another runs sends nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val trash = ScriptedTrash(restore = {
            gate.await()
            RepositoryResult.Content(emptyList())
        })
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.RestoreSelected)
        vm.onAction(TrashAction.Restore("nope"))
        runCurrent()
        assertTrue(trash.restored.isEmpty())
        vm.onAction(TrashAction.Restore("i1"))
        vm.onAction(TrashAction.Restore("i2"))
        runCurrent()
        assertEquals(1, trash.restored.size)
        gate.complete(Unit)
        runCurrent()
        vm.close()
    }

    @Test fun `a refused restore keeps the list and says why until dismissed`() = runTest(dispatcher) {
        val trash = ScriptedTrash(restore = { RepositoryResult.Failure(FailureKind.REJECTED) })
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.Restore("i1"))
        runCurrent()
        assertEquals(listOf(row(TASK), row(FILE)), vm.state.value.items)
        assertEquals(false, vm.state.value.working)
        assertEquals(Failed(FailureKind.REJECTED), vm.state.value.writeFailure)
        assertEquals(1, trash.itemCalls.calls)
        assertTrue(effectsOf(vm).isEmpty())
        vm.close()
    }

    @Test fun `closing cancels the load and ignores later actions and clearing the store does the same`() =
        runTest(dispatcher) {
            val trash = ScriptedTrash(items = listOf(neverAnswers()))
            val vm = viewModel(trash)
            runCurrent()
            vm.close()
            runCurrent()
            assertEquals(1, trash.itemCalls.cancellations)
            vm.onAction(TrashAction.Retry)
            vm.onAction(TrashAction.Restore("i1"))
            runCurrent()
            assertEquals(1, trash.itemCalls.calls)
            assertTrue(trash.restored.isEmpty())
            assertTrue(vm.effects.toList().isEmpty())

            val stored = ScriptedTrash(items = listOf(neverAnswers()))
            val store = ViewModelStore()
            val owned = store.provide {
                AccountViewModelFactory(
                    AccountUnusedAccount,
                    AccountUnusedNotifications,
                    AccountUnusedUsage,
                    stored,
                    FakeAuthRepository(),
                ).trashViewModel()
            }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(owned.isClosed)
            assertEquals(1, stored.itemCalls.cancellations)
        }

    @Test fun `a load that was superseded and answers late is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val trash = ScriptedTrash(
            items = listOf(
                answersLate(gate, RepositoryResult.Content(AccountTrashPage(listOf(MORE), 1, null))),
                { RepositoryResult.Content(AccountTrashPage(listOf(TASK), 1, null)) },
            ),
        )
        val vm = viewModel(trash)
        runCurrent()
        vm.onAction(TrashAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf(row(TASK)), vm.state.value.items)
        vm.close()
    }

    @Test fun `a write elsewhere in the window reads the shown tab again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val trash = ScriptedTrash(
            items = listOf<ScriptedStep<AccountTrashPage>>(
                { RepositoryResult.Content(AccountTrashPage(listOf(TASK, FILE), 3, "c1")) },
                { RepositoryResult.Content(AccountTrashPage(listOf(MORE), 1, null)) },
            ),
        )
        val vm = AccountViewModelFactory(
            AccountUnusedAccount,
            AccountUnusedNotifications,
            AccountUnusedUsage,
            trash,
            FakeAuthRepository(),
            changes,
        ).trashViewModel()
        runCurrent()
        changes.emit(Unit)
        runCurrent()
        assertEquals(2, trash.itemCalls.calls)
        assertEquals(listOf<String?>(null, null), trash.cursors)
        assertEquals(listOf(row(MORE)), vm.state.value.items)
        vm.close()
    }
}
