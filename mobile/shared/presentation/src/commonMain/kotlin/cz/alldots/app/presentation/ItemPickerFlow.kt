package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CollectionDatabase
import cz.alldots.app.domain.CollectionProperty
import cz.alldots.app.domain.CollectionWrites
import cz.alldots.app.domain.FindRelationTargets
import cz.alldots.app.domain.PropertyKind
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * Pointing a relation of the item at another item: a search over the target database, then the choice. A choice
 * replaces the target of a single-valued relation; a relation that holds several targets refuses that, and the
 * choice is added to it instead.
 */
internal class ItemPickerFlow(
    private val host: FlowHost<ItemState, ItemEffect>,
    private val find: FindRelationTargets,
    private val writes: CollectionWrites,
    private val itemId: String,
    private val database: () -> CollectionDatabase?,
    private val mutate: (String?, suspend () -> RepositoryResult<Any?>) -> Unit,
) {
    private var property: CollectionProperty? = null
    private var job: Job? = null

    fun handle(action: ItemAction.Picker) {
        when (action) {
            is ItemAction.Picker.Open -> database()?.property(action.propertyKey)?.let { open(it, "") }
            is ItemAction.Picker.Search -> property?.let { open(it, action.text) }
            is ItemAction.Picker.Choose -> choose(action.targetId)
            ItemAction.Picker.Close -> close()
        }
    }

    private fun open(target: CollectionProperty, text: String) {
        if (target.kind != PropertyKind.RELATION) return
        property = target
        job?.cancel()
        host.update {
            it.copy(picker = PickerView(target.key, target.name, true, null, it.picker?.candidates.orEmpty()))
        }
        job = host.scope.launch {
            val answered = answer { find(target, text) }
            ensureActive()
            host.update { state ->
                val picker = state.picker ?: return@update state
                when (answered) {
                    is Answer.Rejected ->
                        state.copy(picker = picker.copy(loading = false, failure = Failed(answered.kind)))
                    is Answer.Done -> state.copy(
                        picker = picker.copy(
                            loading = false,
                            failure = null,
                            candidates = answered.value.map { TargetView(it.id, it.databaseKey, it.title, it.color) },
                        ),
                    )
                }
            }
        }
    }

    private fun choose(targetId: String) {
        val chosen = property ?: return
        close()
        mutate(chosen.key) {
            val set = writes.setRelation(itemId, chosen.key, targetId)
            if (set is RepositoryResult.Failure && set.kind == FailureKind.REJECTED) {
                writes.link(itemId, chosen.key, targetId)
            } else {
                set
            }
        }
    }

    private fun close() {
        job?.cancel()
        property = null
        host.update { it.copy(picker = null) }
    }
}
