package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AddPropertyOption
import cz.alldots.app.domain.CollectionProperty
import cz.alldots.app.domain.CollectionReads
import cz.alldots.app.domain.CollectionWrites
import cz.alldots.app.domain.FieldValue
import cz.alldots.app.domain.ItemDetail
import cz.alldots.app.domain.PropertyKind
import cz.alldots.app.domain.RemovePropertyOption
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.UpdatePropertyOption

/**
 * The writes of a choice of a select or multi-select itself: adding one and setting it on the item, renaming,
 * recoloring and removing one, each for every item of the database. Each goes through a use case that reads the
 * schema again after a write that went through, and [mutate] reads the item again afterwards. A blank name changes
 * nothing. A refused write and a property that is not a select or multi-select or that the person cannot edit
 * (refused without a request) are each an [ItemState.choiceFailure], never an [ItemState.writeFailure].
 */
internal class ItemChoiceFlow(
    private val host: FlowHost<ItemState, ItemEffect>,
    reads: CollectionReads,
    private val writes: CollectionWrites,
    private val detail: () -> ItemDetail?,
    private val isBlocked: (ItemDetail, String) -> Boolean,
    private val mutate: (String, suspend () -> RepositoryResult<Any?>) -> Unit,
) {
    private val addOption = AddPropertyOption(reads, writes)
    private val updateOption = UpdatePropertyOption(reads, writes)
    private val removeOption = RemovePropertyOption(reads, writes)

    fun handle(action: ItemAction.Edit.Choice) {
        val current = detail() ?: return
        val write: (suspend (CollectionProperty) -> RepositoryResult<Any?>)? = when (action) {
            is ItemAction.Edit.AddChoice -> named(action.label)?.let { name -> { addAndChoose(current, it, name) } }
            is ItemAction.Edit.RenameChoice ->
                named(action.label)?.let { name -> { updateOption(it, action.key, name, null) } }
            is ItemAction.Edit.RecolorChoice -> { property -> updateOption(property, action.key, null, action.color) }
            is ItemAction.Edit.RemoveChoice -> { property -> removeOption(property, action.key) }
        }
        if (write == null) return
        val propertyKey = action.propertyKey
        val property = current.database.property(propertyKey)
        if (property == null || property.kind !in CHOICE_KINDS || isBlocked(current, propertyKey)) {
            host.update { it.copy(choiceFailure = ItemWriteFailure(propertyKey, FailureKind.REJECTED)) }
        } else {
            mutate(propertyKey) { write(property) }
        }
    }

    private fun named(label: String): String? = label.trim().ifEmpty { null }

    /** Adds the choice, then writes it into the item's value; a refused add writes nothing. */
    private suspend fun addAndChoose(
        current: ItemDetail,
        property: CollectionProperty,
        name: String,
    ): RepositoryResult<Any?> = when (val added = addOption(property, name)) {
        is RepositoryResult.Failure -> added
        is RepositoryResult.Content -> {
            val change = FieldValue.Choices(chosenWith(current, property, added.value.key))
            writes.update(current.database, current.item.id, current.item.version, mapOf(property.key to change))
        }
    }

    /** The keys a choice property holds once [key] is chosen: a multi-select adds it, a select holds only it. */
    private fun chosenWith(current: ItemDetail, property: CollectionProperty, key: String): List<String> {
        if (property.kind != PropertyKind.MULTI_SELECT) return listOf(key)
        val held = (current.item.values[property.key] as? FieldValue.Choices)?.keys.orEmpty()
        return if (key in held) held else held + key
    }
}

private val CHOICE_KINDS = setOf(PropertyKind.SELECT, PropertyKind.MULTI_SELECT)
