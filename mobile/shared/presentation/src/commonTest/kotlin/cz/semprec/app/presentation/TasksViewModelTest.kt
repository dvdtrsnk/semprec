package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.core.TaskSectionKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.TasksTab
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TaskScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class TasksViewModelTest : MainDispatcherTest() {
    private val fake = FakeWork()

    private fun tasks(start: TasksStart = TasksStart()) = fake.factory().tasksViewModel({ WORK_TODAY }, start)

    private fun TasksViewModel.rows(kind: TaskSectionKind): List<TaskRow> =
        state.value.groups.firstOrNull { it.kind == kind }?.rows.orEmpty()

    private fun content(vararg items: cz.semprec.app.domain.WorkItem) {
        fake.onTasks = { RepositoryResult.Content(items.toList()) }
    }

    @Test fun `loads the tasks of the tab and groups them by day`() = runTest(dispatcher) {
        content(
            aTask("late", "2026-10-13", effective = WORK_TODAY, project = WORK_PROJECT),
            aTask("a", from = "14:00", project = WORK_PROJECT, flagged = true),
            aTask("b", from = "9:00"),
        )
        val vm = tasks()
        assertEquals(TasksPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val state = vm.state.value
        assertEquals(TasksPhase.CONTENT, state.phase)
        assertEquals(listOf(TaskScope.TODAY), fake.scopes)
        assertEquals(listOf(TaskSectionKind.TODAY), state.groups.map { it.kind })
        assertEquals(listOf("b", "a", "late"), vm.rows(TaskSectionKind.TODAY).map { it.id })
        val late = vm.rows(TaskSectionKind.TODAY).last()
        assertEquals("2026-10-13", late.movedFrom)
        assertEquals("Semprec iOS", late.projectTitle)
        assertFalse(late.overdue)
        assertEquals(3, state.openCount)
        assertEquals(listOf("Práce", "Domácnost"), state.areaOptions.map { it.title })
        assertEquals(listOf(2, 0), state.areaOptions.map { it.count })
        assertEquals(3, state.areaAllCount)
        vm.close()
    }

    @Test fun `today is always a group and a task still open from before is overdue`() = runTest(dispatcher) {
        content(aTask("old", "2026-10-10", effective = "2026-10-10"))
        val vm = tasks()
        runCurrent()

        assertEquals(listOf(TaskSectionKind.LATE, TaskSectionKind.TODAY), vm.state.value.groups.map { it.kind })
        assertTrue(vm.rows(TaskSectionKind.LATE).single().overdue)
        assertTrue(vm.rows(TaskSectionKind.TODAY).isEmpty())
        vm.close()
    }

    @Test fun `a repeating task that was missed is marked`() = runTest(dispatcher) {
        content(aTask("m", status = TaskStatus.MISSED).copy(repeat = TaskRepeat.DAILY))
        val vm = tasks()
        runCurrent()

        val row = vm.rows(TaskSectionKind.TODAY).single()
        assertTrue(row.missed)
        assertEquals(TaskRepeat.DAILY, row.repeat)
        vm.close()
    }

    @Test fun `a failed load is an error and retry loads again`() = runTest(dispatcher) {
        fake.onTasks = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = tasks()
        runCurrent()
        assertEquals(TasksPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)

        content(aTask("a"))
        vm.onAction(TasksAction.Retry)
        assertEquals(TasksPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(TasksPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a failed catalog or an unexpected exception is an error`() = runTest(dispatcher) {
        fake.areaAnswer = RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val failed = tasks()
        runCurrent()
        assertEquals(FailureKind.UNAUTHORIZED, failed.state.value.failure)
        assertTrue(fake.scopes.isEmpty())

        fake.areaAnswer = RepositoryResult.Content(AREA_LIST)
        fake.projectAnswer = RepositoryResult.Failure(FailureKind.INVALID_DATA)
        val projects = tasks()
        runCurrent()
        assertEquals(FailureKind.INVALID_DATA, projects.state.value.failure)

        fake.projectAnswer = RepositoryResult.Content(listOf(WORK_PROJECT))
        fake.onTasks = { error("boom") }
        val crashed = tasks()
        runCurrent()
        assertEquals(TasksPhase.ERROR, crashed.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, crashed.state.value.failure)
        failed.close()
        projects.close()
        crashed.close()
    }

    @Test fun `the catalogs load once and a tab loads its own scope`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.SelectTab(TasksTab.PLANNED))
        assertEquals(TasksPhase.LOADING, vm.state.value.phase)
        runCurrent()
        vm.onAction(TasksAction.SelectTab(TasksTab.PLANNED))
        runCurrent()
        vm.onAction(TasksAction.SelectTab(TasksTab.ALL))
        runCurrent()

        assertEquals(listOf(TaskScope.TODAY, TaskScope.PLANNED, TaskScope.ALL), fake.scopes)
        assertEquals(1, fake.catalogCalls)
        assertEquals(TasksTab.ALL, vm.state.value.tab)
        vm.close()
    }

    @Test fun `the start sets the tab the hidden tasks and the filter`() = runTest(dispatcher) {
        content(
            aTask("a", project = WORK_PROJECT),
            aTask("b", project = WORK_PROJECT, status = TaskStatus.DONE),
            aTask("c", project = HOME_PROJECT),
        )
        val vm = tasks(TasksStart(TasksTab.ALL, hideDone = true, areaId = "a-work"))
        runCurrent()

        val state = vm.state.value
        assertEquals(TasksTab.ALL, state.tab)
        assertEquals(listOf(TaskScope.ALL), fake.scopes)
        assertEquals(listOf("a"), vm.rows(TaskSectionKind.TODAY).map { it.id })
        assertEquals(1, state.openCount)
        assertTrue(state.filterActive)
        vm.close()
    }

    @Test fun `hiding done tasks leaves the open ones and showing them brings them back`() = runTest(dispatcher) {
        content(aTask("a"), aTask("b", status = TaskStatus.DONE))
        val vm = tasks()
        runCurrent()
        assertEquals(listOf("a", "b"), vm.rows(TaskSectionKind.TODAY).map { it.id })
        assertTrue(vm.rows(TaskSectionKind.TODAY).last().done)

        vm.onAction(TasksAction.ToggleHideDone)
        assertEquals(listOf("a"), vm.rows(TaskSectionKind.TODAY).map { it.id })
        vm.onAction(TasksAction.ToggleHideDone)
        assertEquals(2, vm.rows(TaskSectionKind.TODAY).size)
        assertEquals(1, vm.state.value.openCount)
        vm.close()
    }

    @Test fun `the filter narrows the list and says when it hides everything`() = runTest(dispatcher) {
        content(aTask("a", project = WORK_PROJECT, flagged = true), aTask("b", project = HOME_PROJECT), aTask("c"))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.SetArea("a-home"))
        assertEquals(listOf("b"), vm.rows(TaskSectionKind.TODAY).map { it.id })
        assertEquals(listOf("Koupelna"), vm.state.value.projectOptions.map { it.title })
        vm.onAction(TasksAction.SetProject("p-home"))
        vm.onAction(TasksAction.SetFlaggedOnly(true))
        assertTrue(vm.state.value.matchesNothing)
        assertEquals(0, vm.state.value.openCount)

        vm.onAction(TasksAction.ClearFilters)
        assertFalse(vm.state.value.filterActive)
        assertFalse(vm.state.value.matchesNothing)
        assertEquals(3, vm.rows(TaskSectionKind.TODAY).size)
        vm.close()
    }

    @Test fun `another area drops the project of the first area but the same area keeps it`() = runTest(dispatcher) {
        content(aTask("a", project = WORK_PROJECT))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.SetProject("p-work"))
        vm.onAction(TasksAction.SetArea("a-work"))
        assertEquals("p-work", vm.state.value.projectId)
        vm.onAction(TasksAction.SetArea("a-home"))
        assertNull(vm.state.value.projectId)
        assertEquals("a-home", vm.state.value.areaId)
        vm.onAction(TasksAction.SetArea(null))
        assertNull(vm.state.value.areaId)
        vm.close()
    }

    @Test fun `ticking a task shows at once is written and loads the list again`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        fake.onUpdate = { item, _ ->
            gate.await()
            RepositoryResult.Content(item.copy(status = TaskStatus.DONE, version = "v2"))
        }

        vm.onAction(TasksAction.ToggleDone("a"))
        assertTrue(vm.rows(TaskSectionKind.TODAY).single().done)
        assertEquals(0, vm.state.value.openCount)
        gate.complete(Unit)
        runCurrent()

        assertEquals(ItemChange.Done(true), fake.updates.single().second)
        assertEquals("v1", fake.updates.single().first.version)
        assertEquals(2, fake.scopes.size, "A done task is loaded again, as the server may have moved a repeating one")
        assertNull(vm.state.value.notice)
        vm.close()
    }

    @Test fun `a task done is ticked off again`() = runTest(dispatcher) {
        content(aTask("a", status = TaskStatus.DONE))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.ToggleDone("a"))
        assertFalse(vm.rows(TaskSectionKind.TODAY).single().done)
        runCurrent()

        assertEquals(ItemChange.Done(false), fake.updates.single().second)
        vm.close()
    }

    @Test fun `a refused tick is undone with a notice`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()
        fake.onUpdate = { _, _ -> RepositoryResult.Failure(FailureKind.REJECTED) }

        vm.onAction(TasksAction.ToggleDone("a"))
        runCurrent()

        assertFalse(vm.rows(TaskSectionKind.TODAY).single().done)
        assertEquals(FailureKind.REJECTED, vm.state.value.notice)
        vm.onAction(TasksAction.DismissNotice)
        assertNull(vm.state.value.notice)
        assertEquals(1, fake.scopes.size)
        vm.close()
    }

    @Test fun `an unexpected exception in a write is an unavailable notice`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()
        fake.onUpdate = { _, _ -> error("boom") }

        vm.onAction(TasksAction.ToggleDone("a"))
        runCurrent()

        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.notice)
        assertFalse(vm.rows(TaskSectionKind.TODAY).single().done)
        vm.close()
    }

    @Test fun `a task that is no longer there is not ticked`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.ToggleDone("gone"))
        vm.onAction(TasksAction.Rename("gone", "X"))
        runCurrent()

        assertTrue(fake.updates.isEmpty())
        vm.close()
    }

    @Test fun `renaming writes the trimmed title and ignores a blank or unchanged one`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.Rename("a", "  "))
        vm.onAction(TasksAction.Rename("a", "Task a"))
        assertTrue(fake.updates.isEmpty())
        vm.onAction(TasksAction.Rename("a", " Nový název "))
        assertEquals("Nový název", vm.rows(TaskSectionKind.TODAY).single().title)
        runCurrent()

        assertEquals(ItemChange.Title("Nový název"), fake.updates.single().second)
        assertEquals(1, fake.scopes.size)
        vm.close()
    }

    @Test fun `a renamed title with line breaks is written on one line`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.Rename("a", "Nový\nnázev"))
        runCurrent()

        assertEquals(ItemChange.Title("Nový název"), fake.updates.single().second)
        vm.close()
    }

    @Test fun `a new task is created for today in the chosen project and the list loads again`() = runTest(dispatcher) {
        content(aTask("a"))
        fake.onCreate = { RepositoryResult.Content(aTask("n")) }
        val vm = tasks(TasksStart(projectId = "p-work"))
        runCurrent()

        vm.onAction(TasksAction.Add("   "))
        vm.onAction(TasksAction.Add(" Koupit mléko "))
        runCurrent()

        assertEquals(1, fake.created.size)
        assertEquals("Koupit mléko", fake.created.single().title)
        assertEquals(WORK_TODAY, fake.created.single().date)
        assertEquals("p-work", fake.created.single().projectId)
        assertEquals(2, fake.scopes.size)
        vm.close()
    }

    @Test fun `a task that could not be created is a notice`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.Add("Nový"))
        runCurrent()
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.notice)

        fake.onCreate = { error("boom") }
        vm.onAction(TasksAction.DismissNotice)
        vm.onAction(TasksAction.Add("Nový"))
        runCurrent()
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.notice)
        vm.close()
    }

    @Test fun `opening the details of a task is an effect`() = runTest(dispatcher) {
        val vm = tasks()
        runCurrent()

        vm.onAction(TasksAction.OpenDetails("a"))

        val received = mutableListOf<TasksEffect>()
        val job = launch { vm.effects.collect { received += it } }
        runCurrent()
        job.cancel()
        assertEquals(listOf<TasksEffect>(TasksEffect.OpenDetails("a")), received)
        vm.close()
    }

    @Test fun `a refresh keeps the list and a failed refresh is a notice`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        content(aTask("a"), aTask("b"))
        vm.onAction(TasksAction.Refresh)
        assertEquals(TasksPhase.CONTENT, vm.state.value.phase)
        runCurrent()
        assertEquals(2, vm.rows(TaskSectionKind.TODAY).size)

        fake.onTasks = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        vm.onAction(TasksAction.Refresh)
        runCurrent()
        assertEquals(TasksPhase.CONTENT, vm.state.value.phase)
        assertEquals(2, vm.rows(TaskSectionKind.TODAY).size)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.notice)
        vm.close()
    }

    @Test fun `a change made elsewhere loads the list again`() = runTest(dispatcher) {
        content(aTask("a"))
        val vm = tasks()
        runCurrent()

        content(aTask("a"), aTask("b"))
        fake.changes.announce()
        runCurrent()

        assertEquals(2, vm.rows(TaskSectionKind.TODAY).size)
        vm.close()
    }

    @Test fun `a newer load supersedes an older one that answers late`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        var calls = 0
        fake.onTasks = { scope ->
            calls += 1
            if (calls == 1) {
                withContext(NonCancellable) { gate.await() }
                RepositoryResult.Content(listOf(aTask("old")))
            } else {
                RepositoryResult.Content(listOf(aTask("new-${scope.name}")))
            }
        }
        val vm = tasks()
        runCurrent()
        vm.onAction(TasksAction.SelectTab(TasksTab.ALL))
        runCurrent()
        assertEquals(listOf("new-ALL"), vm.rows(TaskSectionKind.TODAY).map { it.id })

        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf("new-ALL"), vm.rows(TaskSectionKind.TODAY).map { it.id })
        vm.close()
    }

    @Test fun `closing ends everything and a late answer publishes nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        fake.onTasks = {
            withContext(NonCancellable) { gate.await() }
            RepositoryResult.Content(listOf(aTask("a")))
        }
        val vm = tasks()
        runCurrent()
        vm.close()
        vm.close()
        assertTrue(vm.isClosed)

        gate.complete(Unit)
        runCurrent()
        vm.onAction(TasksAction.Retry)
        runCurrent()

        assertEquals(TasksPhase.LOADING, vm.state.value.phase)
        assertEquals(1, fake.scopes.size)
    }

    @Test fun `clearing the store ends the view model without close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { tasks() }
        runCurrent()

        store.clear()

        assertTrue(vm.isClosed)
        vm.onAction(TasksAction.ToggleHideDone)
        assertFalse(vm.state.value.hideDone)
    }
}
