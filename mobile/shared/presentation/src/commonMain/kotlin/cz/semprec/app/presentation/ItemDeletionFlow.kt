package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionWrites
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * Deleting the item: the confirmation first reads what the deletion reaches, so it can say so, and only a
 * confirmation that follows a read impact deletes. The item then goes to the trash and the screen is asked to close.
 */
internal class ItemDeletionFlow(
    private val host: FlowHost<ItemState, ItemEffect>,
    private val reads: CollectionReads,
    private val writes: CollectionWrites,
    private val itemId: String,
) {
    private var job: Job? = null

    fun handle(action: ItemAction.Deletion) {
        when (action) {
            ItemAction.Deletion.Request -> request()
            ItemAction.Deletion.Cancel -> {
                job?.cancel()
                host.update { it.copy(deletion = null) }
            }
            ItemAction.Deletion.Confirm -> confirm()
        }
    }

    private fun request() {
        if (job?.isActive == true) return
        val reading = DeletionView(loading = true, failure = null, impact = null, deleting = false)
        host.update { it.copy(deletion = reading) }
        job = host.scope.launch {
            val impact = answer { reads.deleteImpact(itemId) }
            ensureActive()
            host.update {
                when (impact) {
                    is Answer.Rejected -> it.copy(deletion = DeletionView(false, Failed(impact.kind), null, false))
                    is Answer.Done -> it.copy(deletion = DeletionView(false, null, impact.value.toView(), false))
                }
            }
        }
    }

    private fun confirm() {
        if (job?.isActive == true || host.state.deletion?.impact == null) return
        host.update { it.copy(deletion = it.deletion?.copy(deleting = true)) }
        job = host.scope.launch {
            val deleted = answer { writes.delete(itemId) }
            ensureActive()
            when (deleted) {
                is Answer.Rejected ->
                    host.update { it.copy(deletion = it.deletion?.copy(deleting = false, failure = Failed(deleted.kind))) }
                is Answer.Done -> {
                    host.update { it.copy(deleted = true, deletion = null) }
                    host.emit(ItemEffect.Close)
                }
            }
        }
    }
}
