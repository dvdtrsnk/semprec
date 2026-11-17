package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.DeleteImpact
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The item screen and the writes made elsewhere in its window. */
@OptIn(ExperimentalCoroutinesApi::class)
class ItemViewModelChangesTest : MainDispatcherTest() {
    private val fake = FakeCollections()

    @Test fun `a write elsewhere in the window reads the item again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        fake.itemAnswer = { RepositoryResult.Content(projectItem("p1", "Semprec iOS")) }
        val vm = CollectionViewModelFactory(fake, fake, changes).itemViewModel("p1", "projects")
        runCurrent()
        assertEquals("Semprec iOS", vm.state.value.header?.title)
        val reads = fake.itemReads
        fake.itemAnswer = { RepositoryResult.Content(projectItem("p1", "Renamed elsewhere")) }
        changes.emit(Unit)
        runCurrent()
        assertEquals(reads + 1, fake.itemReads)
        assertEquals("Renamed elsewhere", vm.state.value.header?.title)
        vm.close()
    }

    @Test fun `a write refused for an old version is retried by the person with the version read after it`() =
        runTest(dispatcher) {
            val project = projectItem("p1", "Semprec iOS")
            fake.itemAnswer = { RepositoryResult.Content(project) }
            val vm = CollectionViewModelFactory(fake, fake).itemViewModel("p1", "projects")
            runCurrent()
            fake.updateAnswer = { failure(FailureKind.REJECTED) }
            fake.itemAnswer = { RepositoryResult.Content(project.copy(version = "v2")) }
            vm.onAction(ItemAction.Edit.SetNumber("budget", 2000.0))
            runCurrent()
            assertEquals(ItemWriteFailure("budget", FailureKind.REJECTED), vm.state.value.writeFailure)
            fake.updateAnswer = { RepositoryResult.Content(project.copy(version = "v3")) }
            vm.onAction(ItemAction.Edit.SetNumber("budget", 2000.0))
            runCurrent()
            assertEquals(listOf(project.version, "v2"), fake.updates.map { it.second })
            assertNull(vm.state.value.writeFailure)
            vm.close()
        }

    @Test fun `closing the confirmation while the deletion is sent does not call the deletion back`() =
        runTest(dispatcher) {
            fake.itemAnswer = { RepositoryResult.Content(projectItem("p1", "Semprec iOS")) }
            fake.impactAnswer = { RepositoryResult.Content(DeleteImpact(emptyList(), 0, 0, 0, 0, 0, 0)) }
            val vm = CollectionViewModelFactory(fake, fake).itemViewModel("p1", "projects")
            runCurrent()
            vm.onAction(ItemAction.Deletion.Request)
            runCurrent()
            val gate = CompletableDeferred<Unit>()
            fake.unitAnswer = {
                gate.await()
                RepositoryResult.Content(Unit)
            }
            vm.onAction(ItemAction.Deletion.Confirm)
            runCurrent()
            // The system dialog closes as its button is tapped and reports that as a cancel.
            vm.onAction(ItemAction.Deletion.Cancel)
            assertTrue(vm.state.value.deletion?.deleting == true)
            gate.complete(Unit)
            runCurrent()
            assertTrue("delete:p1" in fake.calls)
            assertTrue(vm.state.value.deleted)
            assertNull(vm.state.value.deletion)
            vm.close()
        }
}
