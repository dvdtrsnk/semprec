package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.FindRelationTargets
import cz.semprec.app.domain.ItemDetail
import cz.semprec.app.domain.LoadItemDetail
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * One item of any database: its properties with the origin of every value that is not its own, its related
 * collections, its page, a preview of its file and the relation picker. A value that follows another item shows that
 * and is changed, unlinked or taken over again through the item's link endpoints; writing a followed value ends the
 * link, as the server decides. The page, the preview, the picker and the deletion are flows of their own over this
 * ViewModel's state. A newer read supersedes an older one, and an answer that arrives after the ViewModel was closed
 * or superseded is dropped.
 */
class ItemViewModel internal constructor(
    private val itemId: String,
    private val databaseKeyHint: String?,
    private val loadDetail: LoadItemDetail,
    findTargets: FindRelationTargets,
    reads: CollectionReads,
    private val writes: CollectionWrites,
) : ScreenViewModel<ItemState, ItemAction, ItemEffect>(ItemState()) {
    private var detail: ItemDetail? = null
    private var loadJob: Job? = null
    private var writeJob: Job? = null
    private val host = FlowHost<ItemState, ItemEffect>(viewModelScope, { state.value }, { update(it) }, { emit(it) })
    private val page = ItemPageFlow(host, reads, writes, itemId)
    private val preview = ItemPreviewFlow(host, reads)
    private val deletion = ItemDeletionFlow(host, reads, writes, itemId)
    private val picker = ItemPickerFlow(host, findTargets, writes, itemId, { detail?.database }, ::mutate)

    init {
        load(quiet = false)
    }

    override fun onAction(action: ItemAction) {
        if (isClosed) return
        when (action) {
            ItemAction.Retry -> load(quiet = false)
            ItemAction.Refresh -> load(quiet = true)
            ItemAction.DismissWriteFailure -> update { it.copy(writeFailure = null) }
            is ItemAction.Edit -> edit(action)
            is ItemAction.Picker -> picker.handle(action)
            is ItemAction.Page -> page.handle(action)
            is ItemAction.Preview -> preview.handle(action)
            is ItemAction.Deletion -> deletion.handle(action)
            is ItemAction.Navigate -> navigate(action)
        }
    }

    /** Reads the item and its related collections; [quiet] keeps what is on screen until the answer replaces it. */
    private fun load(quiet: Boolean) {
        loadJob?.cancel()
        if (!quiet) {
            writeJob?.cancel()
            update { ItemState() }
        }
        loadJob = viewModelScope.launch {
            val answered = answer { loadDetail(itemId, databaseKeyHint) }
            ensureActive()
            when (answered) {
                is Answer.Rejected ->
                    if (quiet) update { it.copy(saving = false) } else update { itemFailure(answered.kind) }
                is Answer.Done -> {
                    detail = answered.value
                    update { itemState(answered.value, it) }
                    if (!quiet) page.load()
                }
            }
        }
    }

    private fun edit(action: ItemAction.Edit) {
        when (action) {
            is ItemAction.Edit.Rename -> write(null, titleChange(detail?.database, action.title))
            is ItemAction.Edit.SetText -> write(action.propertyKey, mapOf(action.propertyKey to textValue(action.text)))
            is ItemAction.Edit.SetNumber ->
                write(action.propertyKey, mapOf(action.propertyKey to action.number?.let { FieldValue.Number(it) }))
            is ItemAction.Edit.SetFlag ->
                write(action.propertyKey, mapOf(action.propertyKey to FieldValue.Flag(action.on)))
            is ItemAction.Edit.SetChoices ->
                write(action.propertyKey, mapOf(action.propertyKey to choiceValue(action.keys)))
            is ItemAction.Edit.Unlink -> mutate(action.propertyKey) { writes.unlinkValue(itemId, action.propertyKey) }
            is ItemAction.Edit.Relink -> mutate(action.propertyKey) { writes.relinkValue(itemId, action.propertyKey) }
            is ItemAction.Edit.RemoveTarget ->
                mutate(action.propertyKey) { writes.unlinkEdge(itemId, action.propertyKey, action.targetId) }
        }
    }

    private fun navigate(action: ItemAction.Navigate) {
        when (action) {
            is ItemAction.Navigate.OpenTarget -> emit(ItemEffect.OpenItem(action.id, action.databaseKey))
            is ItemAction.Navigate.OpenRelated ->
                detail?.related?.firstOrNull { it.database.id == action.databaseId }?.let {
                    emit(ItemEffect.OpenCollection(it.database.id, it.database.key, it.filter?.json))
                }
        }
    }

    /** Writes [changes] of the item; a property the person cannot edit (system-owned, derived) is refused. */
    private fun write(propertyKey: String?, changes: Map<String, FieldValue?>) {
        val current = detail
        if (current == null || changes.isEmpty()) return
        val blocked = changes.keys.any { key ->
            current.database.property(key)?.system != false ||
                state.value.fields.firstOrNull { it.propertyKey == key }?.editable == false
        }
        if (blocked) {
            update { it.copy(writeFailure = ItemWriteFailure(propertyKey, FailureKind.REJECTED)) }
        } else {
            mutate(propertyKey) { writes.update(current.database, itemId, current.item.version, changes) }
        }
    }

    /**
     * Runs a write, then reads the item again so its values, origins and version are the server's. A refused write
     * reads it again too: the usual refusal is a version another writer (Semp filling in a new book) moved on, and the
     * person's next attempt must carry the version the server has now.
     */
    private fun mutate(propertyKey: String?, call: suspend () -> RepositoryResult<Any?>) {
        if (writeJob?.isActive == true) return
        update { it.copy(saving = true, writeFailure = null) }
        writeJob = viewModelScope.launch {
            val result = answer(call)
            ensureActive()
            if (result is Answer.Rejected) {
                update { it.copy(saving = false, writeFailure = ItemWriteFailure(propertyKey, result.kind)) }
            }
            load(quiet = true)
        }
    }
}
