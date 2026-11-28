package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.PropertyOption
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

/** Renaming, recoloring and removing a choice of a select or multi-select from an item, as project tags are managed. */
@OptIn(ExperimentalCoroutinesApi::class)
class ItemViewModelChoiceEditTest : MainDispatcherTest() {
    private val fake = FakeCollections()
    private val factory = CollectionViewModelFactory(fake, fake)
    private val client = PropertyOption("a", "Client", "#FF9500")
    private val home = PropertyOption("b", "Home", null)

    private fun schemaWithTags(vararg options: PropertyOption): CollectionSchema {
        val projects = projectsDb.copy(
            properties = projectsDb.properties.map {
                if (it.key == "tags") it.copy(options = options.toList()) else it
            },
        )
        return testSchema.copy(databases = listOf(projects, peopleDb, filesDb))
    }

    private fun projectTagged(vararg keys: String) =
        projectItem("p1", "Semprec iOS", extra = mapOf("tags" to FieldValue.Choices(keys.toList())))

    private fun TestScope.open(): ItemViewModel {
        fake.schemaAnswer = { RepositoryResult.Content(schemaWithTags(client, home)) }
        fake.itemAnswer = { RepositoryResult.Content(projectTagged("a", "b")) }
        val vm = factory.itemViewModel("p1", "projects")
        runCurrent()
        fake.calls.clear()
        return vm
    }

    private val ItemViewModel.tags: FieldView get() = state.value.fields.single { it.propertyKey == "tags" }

    private val ItemViewModel.heldTags: List<OptionView>
        get() = (tags.content as FieldContent.Choices).options

    @Test fun `a renamed tag is patched by its key and the project shows the new name`() = runTest(dispatcher) {
        val vm = open()
        fake.updateOptionAnswer = { key, label, _ ->
            fake.schemaAnswer = { RepositoryResult.Content(schemaWithTags(client.copy(label = "Customer"), home)) }
            RepositoryResult.Content(PropertyOption(key, label.orEmpty(), client.color))
        }
        vm.onAction(ItemAction.Edit.RenameChoice("tags", "a", "  Customer "))
        runCurrent()
        assertEquals(listOf("updateOption:id-tags:a:Customer:null", "refreshSchema"), fake.calls.take(2))
        assertTrue(fake.calls.last().startsWith("item:p1"))
        assertEquals(OptionView("a", "Customer", "#FF9500"), vm.heldTags.first())
        assertEquals(OptionView("a", "Customer", "#FF9500"), vm.tags.options.first())
        assertTrue(fake.updates.isEmpty())
        assertNull(vm.state.value.choiceFailure)
        assertNull(vm.state.value.writeFailure)
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `a recolored tag is patched with only its color and the project shows it`() = runTest(dispatcher) {
        val vm = open()
        fake.updateOptionAnswer = { key, _, color ->
            fake.schemaAnswer = { RepositoryResult.Content(schemaWithTags(client.copy(color = color), home)) }
            RepositoryResult.Content(PropertyOption(key, client.label, color))
        }
        vm.onAction(ItemAction.Edit.RecolorChoice("tags", "a", "#34C759"))
        runCurrent()
        assertEquals(listOf("updateOption:id-tags:a:null:#34C759", "refreshSchema"), fake.calls.take(2))
        assertEquals(OptionView("a", "Client", "#34C759"), vm.heldTags.first())
        assertNull(vm.state.value.choiceFailure)
        vm.close()
    }

    @Test fun `a removed tag is deleted and is gone from the project and its choices`() = runTest(dispatcher) {
        val vm = open()
        fake.removeOptionAnswer = {
            fake.schemaAnswer = { RepositoryResult.Content(schemaWithTags(home)) }
            fake.itemAnswer = { RepositoryResult.Content(projectTagged("b")) }
            RepositoryResult.Content(Unit)
        }
        vm.onAction(ItemAction.Edit.RemoveChoice("tags", "a"))
        runCurrent()
        assertEquals(listOf("removeOption:id-tags:a", "refreshSchema"), fake.calls.take(2))
        assertTrue(fake.calls.last().startsWith("item:p1"))
        assertEquals(listOf(OptionView("b", "Home", null)), vm.heldTags)
        assertEquals(listOf(OptionView("b", "Home", null)), vm.tags.options)
        assertNull(vm.state.value.choiceFailure)
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `a refused change of a tag is a choice failure and changes nothing`() = runTest(dispatcher) {
        val actions = listOf(
            ItemAction.Edit.RenameChoice("tags", "a", "Customer"),
            ItemAction.Edit.RecolorChoice("tags", "a", "#34C759"),
            ItemAction.Edit.RemoveChoice("tags", "a"),
        )
        for (action in actions) {
            fake.updateOptionAnswer = { _, _, _ -> failure(FailureKind.REJECTED) }
            fake.removeOptionAnswer = { failure(FailureKind.REJECTED) }
            val vm = open()
            vm.onAction(action)
            runCurrent()
            assertEquals(ItemWriteFailure("tags", FailureKind.REJECTED), vm.state.value.choiceFailure, "$action")
            assertNull(vm.state.value.writeFailure, "$action")
            assertTrue("refreshSchema" !in fake.calls, "$action")
            assertEquals(listOf(OptionView("a", "Client", "#FF9500"), OptionView("b", "Home", null)), vm.heldTags)
            assertFalse(vm.state.value.saving)
            vm.close()
        }
    }

    @Test fun `a blank new name changes nothing`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(ItemAction.Edit.RenameChoice("tags", "a", "   "))
        runCurrent()
        assertTrue(fake.calls.isEmpty())
        assertNull(vm.state.value.choiceFailure)
        vm.close()
    }

    private fun changesOf(propertyKey: String) = listOf(
        ItemAction.Edit.RenameChoice(propertyKey, "a", "X"),
        ItemAction.Edit.RecolorChoice(propertyKey, "a", "#34C759"),
        ItemAction.Edit.RemoveChoice(propertyKey, "a"),
    )

    /** Sends every change of a choice of [propertyKey] and asserts that each is refused without a request. */
    private fun TestScope.assertRefusedWithoutRequest(vm: ItemViewModel, propertyKey: String) {
        for (action in changesOf(propertyKey)) {
            vm.onAction(ItemAction.DismissWriteFailure)
            vm.onAction(action)
            assertEquals(ItemWriteFailure(propertyKey, FailureKind.REJECTED), vm.state.value.choiceFailure, "$action")
            assertNull(vm.state.value.writeFailure, "$action")
        }
        runCurrent()
        assertTrue(fake.calls.isEmpty(), propertyKey)
    }

    @Test fun `a property that is not a choice is refused without a request`() = runTest(dispatcher) {
        val vm = open()
        assertRefusedWithoutRequest(vm, "note")
        assertRefusedWithoutRequest(vm, "missing")
        vm.close()
    }

    @Test fun `a choice property the system owns is refused without a request`() = runTest(dispatcher) {
        val schema = schemaWithTags(client, home)
        val systemTags = schema.copy(
            databases = schema.databases.map { database ->
                database.copy(
                    properties = database.properties.map { if (it.key == "tags") it.copy(system = true) else it },
                )
            },
        )
        fake.itemAnswer = { RepositoryResult.Content(projectTagged("a", "b")) }
        fake.schemaAnswer = { RepositoryResult.Content(systemTags) }
        val vm = factory.itemViewModel("p1", "projects")
        runCurrent()
        fake.calls.clear()
        assertRefusedWithoutRequest(vm, "tags")
        vm.close()
    }

    @Test fun `a closed item ignores a change of a tag`() = runTest(dispatcher) {
        val vm = open()
        vm.close()
        vm.onAction(ItemAction.Edit.RenameChoice("tags", "a", "Customer"))
        vm.onAction(ItemAction.Edit.RecolorChoice("tags", "a", "#34C759"))
        vm.onAction(ItemAction.Edit.RemoveChoice("tags", "a"))
        runCurrent()
        assertTrue(fake.calls.isEmpty())
    }

    @Test fun `the state offers the palette of colors a tag can take`() = runTest(dispatcher) {
        val vm = open()
        assertEquals(CALENDAR_SWATCHES, vm.state.value.swatches)
        vm.close()
    }
}
