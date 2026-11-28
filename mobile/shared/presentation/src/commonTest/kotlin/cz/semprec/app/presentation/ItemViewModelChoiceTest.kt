package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Creating a new choice of a select or multi-select from an item, as a project's settings add a tag. */
@OptIn(ExperimentalCoroutinesApi::class)
class ItemViewModelChoiceTest : MainDispatcherTest() {
    private val fake = FakeCollections()
    private val factory = CollectionViewModelFactory(fake, fake)
    private val project = projectItem("p1", "Semprec iOS", extra = mapOf("tags" to FieldValue.Choices(listOf("a"))))

    private fun TestScope.open(): ItemViewModel {
        fake.itemAnswer = { RepositoryResult.Content(project) }
        val vm = factory.itemViewModel("p1", "projects")
        runCurrent()
        fake.calls.clear()
        return vm
    }

    @Test fun `a new tag is added through the options route then set beside the held ones`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "  Client "))
        runCurrent()
        assertEquals(listOf("addOption:id-tags:Client", "refreshSchema"), fake.calls.take(2))
        assertEquals(
            listOf(
                Triple("p1", "v-p1", mapOf<String, FieldValue?>("tags" to FieldValue.Choices(listOf("a", "client")))),
            ),
            fake.updates,
        )
        assertNull(vm.state.value.writeFailure)
        assertNull(vm.state.value.choiceFailure)
        assertFalse(vm.state.value.saving)
        assertTrue(fake.calls.last().startsWith("item:p1"))
        vm.close()
    }

    @Test fun `a refused add surfaces a failure and sets no value`() = runTest(dispatcher) {
        fake.addOptionAnswer = { failure(FailureKind.REJECTED) }
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "Client"))
        runCurrent()
        assertChoiceFailure(ItemWriteFailure("tags", FailureKind.REJECTED), vm)
        assertTrue(fake.updates.isEmpty())
        assertTrue("refreshSchema" !in fake.calls)
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `a tag that was added but could not be set is a choice failure too`() = runTest(dispatcher) {
        fake.updateAnswer = { failure(FailureKind.UNAVAILABLE) }
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "Client"))
        runCurrent()
        assertChoiceFailure(ItemWriteFailure("tags", FailureKind.UNAVAILABLE), vm)
        vm.close()
    }

    @Test fun `a choice failure is cleared by the next write and by dismissing`() = runTest(dispatcher) {
        fake.addOptionAnswer = { failure(FailureKind.REJECTED) }
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "Client"))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetFlag("pinned", false))
        assertNull(vm.state.value.choiceFailure)
        runCurrent()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "Client"))
        runCurrent()
        vm.onAction(ItemAction.DismissWriteFailure)
        assertNull(vm.state.value.choiceFailure)
        vm.close()
    }

    @Test fun `a select holds only the new choice`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("status", "Waiting"))
        runCurrent()
        assertEquals(
            mapOf<String, FieldValue?>("status" to FieldValue.Choices(listOf("waiting"))),
            fake.updates.single().third,
        )
        vm.close()
    }

    @Test fun `a blank name changes nothing`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "   "))
        runCurrent()
        assertTrue(fake.calls.isEmpty())
        assertNull(vm.state.value.writeFailure)
        assertNull(vm.state.value.choiceFailure)
        vm.close()
    }

    @Test fun `a property that is not a choice or cannot be edited is refused without a request`() =
        runTest(dispatcher) {
            val vm = open()
            vm.onAction(ItemAction.Edit.AddChoice("note", "x"))
            assertChoiceFailure(ItemWriteFailure("note", FailureKind.REJECTED), vm)
            vm.onAction(ItemAction.Edit.AddChoice("missing", "x"))
            assertChoiceFailure(ItemWriteFailure("missing", FailureKind.REJECTED), vm)
            runCurrent()
            assertTrue(fake.calls.isEmpty())
            vm.close()
        }

    @Test fun `a choice property the system owns is refused without a request`() = runTest(dispatcher) {
        val systemTags = projectsDb.copy(
            properties = projectsDb.properties.map { if (it.key == "tags") it.copy(system = true) else it },
        )
        val schema = testSchema.copy(databases = listOf(systemTags, peopleDb, filesDb))
        fake.schemaAnswer = { RepositoryResult.Content(schema) }
        val vm = open()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "Client"))
        assertChoiceFailure(ItemWriteFailure("tags", FailureKind.REJECTED), vm)
        runCurrent()
        assertTrue(fake.calls.isEmpty())
        vm.close()
    }

    @Test fun `a closed item ignores an added choice`() = runTest(dispatcher) {
        val vm = open()
        vm.close()
        vm.onAction(ItemAction.Edit.AddChoice("tags", "Client"))
        runCurrent()
        assertTrue(fake.calls.isEmpty())
    }
}

/** A failed new choice is shown once: as the item's choice failure, never as its write failure. */
private fun assertChoiceFailure(expected: ItemWriteFailure, vm: ItemViewModel) {
    assertEquals(expected, vm.state.value.choiceFailure)
    assertNull(vm.state.value.writeFailure)
}
