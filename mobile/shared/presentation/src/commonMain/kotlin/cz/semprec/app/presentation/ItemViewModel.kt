package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionProperty
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.ItemDetail
import cz.semprec.app.domain.FindRelationTargets
import cz.semprec.app.domain.LoadItemDetail
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * One item of any database: its properties with the origin of every value that is not its own, its related
 * collections, its page, a preview of its file and the relation picker. A value that follows another item shows that
 * and is changed, unlinked or taken over again through the item's link endpoints; writing a followed value ends the
 * link, as the server decides. A newer read supersedes an older one, and an answer that arrives after the ViewModel
 * was closed or superseded is dropped.
 */
class ItemViewModel internal constructor(
    private val itemId: String,
    private val databaseKeyHint: String?,
    private val loadDetail: LoadItemDetail,
    private val findTargets: FindRelationTargets,
    private val reads: CollectionReads,
    private val writes: CollectionWrites,
) : ScreenViewModel<ItemState, ItemAction, ItemEffect>(ItemState()) {
    private var detail: ItemDetail? = null
    private var pageEtag: String? = null
    private var loadJob: Job? = null
    private var writeJob: Job? = null
    private var sideJob: Job? = null
    private var pickerProperty: CollectionProperty? = null

    init {
        load(quiet = false)
    }

    override fun onAction(action: ItemAction) {
        if (isClosed) return
        when (action) {
            ItemAction.Retry -> load(quiet = false)
            ItemAction.Refresh -> load(quiet = true)
            is ItemAction.Rename -> write(null, titleChange(detail?.database, action.title))
            is ItemAction.SetText -> write(action.propertyKey, mapOf(action.propertyKey to textValue(action.text)))
            is ItemAction.SetNumber ->
                write(action.propertyKey, mapOf(action.propertyKey to action.number?.let { FieldValue.Number(it) }))
            is ItemAction.SetFlag -> write(action.propertyKey, mapOf(action.propertyKey to FieldValue.Flag(action.on)))
            is ItemAction.SetChoices -> write(action.propertyKey, mapOf(action.propertyKey to choiceValue(action.keys)))
            is ItemAction.Unlink -> mutate(action.propertyKey) { writes.unlinkValue(itemId, action.propertyKey) }
            is ItemAction.Relink -> mutate(action.propertyKey) { writes.relinkValue(itemId, action.propertyKey) }
            is ItemAction.OpenPicker -> searchPicker(action.propertyKey, "")
            is ItemAction.SearchPicker -> pickerProperty?.let { searchPicker(it.key, action.text) }
            is ItemAction.Pick -> pick(action.targetId)
            ItemAction.ClosePicker -> closePicker()
            is ItemAction.RemoveTarget ->
                mutate(action.propertyKey) { writes.unlinkEdge(itemId, action.propertyKey, action.targetId) }
            is ItemAction.SavePage -> page(action.markdown)
            ItemAction.ReloadPage -> page(null)
            is ItemAction.LoadPreview -> preview(action.propertyKey)
            ItemAction.ClosePreview -> update { it.copy(preview = null) }
            ItemAction.RequestDelete -> delete(confirmed = false)
            ItemAction.CancelDelete -> update { it.copy(deletion = null) }
            ItemAction.ConfirmDelete -> delete(confirmed = true)
            is ItemAction.OpenRelated -> detail?.related?.firstOrNull { it.database.id == action.databaseId }?.let {
                emit(ItemEffect.OpenCollection(it.database.id, it.database.key, it.filter?.json))
            }
            is ItemAction.OpenTarget -> emit(ItemEffect.OpenItem(action.id, action.databaseKey))
            ItemAction.DismissWriteFailure -> update { it.copy(writeFailure = null) }
        }
    }

    /** Reads the item and its related collections; [quiet] keeps what is on screen until the answer replaces it. */
    private fun load(quiet: Boolean) {
        loadJob?.cancel()
        if (!quiet) {
            sideJob?.cancel()
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
                    if (!quiet) page(null)
                }
            }
        }
    }

    /** Writes [changes] of the item; a property the person cannot edit (system-owned, derived) is refused. */
    private fun write(propertyKey: String?, changes: Map<String, FieldValue?>) {
        val current = detail ?: return
        if (changes.isEmpty()) return
        val blocked = changes.keys.any { key ->
            val property = current.database.property(key)
            property == null || property.system || state.value.fields.firstOrNull { it.propertyKey == key }?.editable == false
        }
        if (blocked) {
            update { it.copy(writeFailure = ItemWriteFailure(propertyKey, FailureKind.REJECTED)) }
            return
        }
        mutate(propertyKey) { writes.update(current.database, itemId, current.item.version, changes) }
    }

    /** Runs a write, then reads the item again so its values, origins and version are the server's. */
    private fun <T> mutate(propertyKey: String?, call: suspend () -> RepositoryResult<T>) {
        if (writeJob?.isActive == true) return
        update { it.copy(saving = true, writeFailure = null) }
        writeJob = viewModelScope.launch {
            val result = answer(call)
            ensureActive()
            when (result) {
                is Answer.Rejected ->
                    update { it.copy(saving = false, writeFailure = ItemWriteFailure(propertyKey, result.kind)) }
                is Answer.Done -> load(quiet = true)
            }
        }
    }

    private fun searchPicker(propertyKey: String, text: String) {
        val property = detail?.database?.property(propertyKey)?.takeIf { it.kind == PropertyKind.RELATION } ?: return
        pickerProperty = property
        sideJob?.cancel()
        update { it.copy(picker = PickerView(property.key, property.name, true, null, it.picker?.candidates.orEmpty())) }
        sideJob = viewModelScope.launch {
            val answered = answer { findTargets(property, text) }
            ensureActive()
            update { state ->
                val picker = state.picker ?: return@update state
                when (answered) {
                    is Answer.Rejected -> state.copy(picker = picker.copy(loading = false, failure = answered.kind))
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

    /** Points the relation of the open picker at the chosen item: replaces a single target, else adds one. */
    private fun pick(targetId: String) {
        val property = pickerProperty ?: return
        closePicker()
        mutate(property.key) {
            val set = writes.setRelation(itemId, property.key, targetId)
            if (set is RepositoryResult.Failure && set.kind == FailureKind.REJECTED) {
                writes.link(itemId, property.key, targetId)
            } else {
                set
            }
        }
    }

    private fun closePicker() {
        sideJob?.cancel()
        pickerProperty = null
        update { it.copy(picker = null) }
    }

    /** Loads the page, or saves [markdown] as the new page when it is given. */
    private fun page(markdown: String?) {
        if (markdown != null && pageEtag == null) return
        sideJob?.cancel()
        update { it.copy(page = it.page.copy(status = if (markdown == null) PageStatus.LOADING else PageStatus.SAVING)) }
        sideJob = viewModelScope.launch {
            val etag = pageEtag
            val answered = answer { if (markdown == null || etag == null) reads.page(itemId) else writes.replacePage(itemId, markdown, etag) }
            ensureActive()
            when (answered) {
                is Answer.Rejected -> update { it.copy(page = it.page.copy(status = PageStatus.ERROR, failure = answered.kind)) }
                is Answer.Done -> {
                    pageEtag = answered.value.etag
                    update { it.copy(page = PageView(PageStatus.READY, answered.value.markdown, null)) }
                }
            }
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun preview(propertyKey: String) {
        val blob = state.value.fields.firstOrNull { it.propertyKey == propertyKey }?.content as? FieldContent.Blob ?: return
        sideJob?.cancel()
        update { it.copy(preview = PreviewView(blob.blobId, blob.filename, blob.mimeType, PreviewStatus.LOADING, null, null)) }
        sideJob = viewModelScope.launch {
            val answered = answer { reads.blob(blob.blobId) }
            ensureActive()
            if (state.value.preview?.blobId != blob.blobId) return@launch
            update {
                val shown = it.preview ?: return@update it
                when (answered) {
                    is Answer.Rejected -> it.copy(preview = shown.copy(status = PreviewStatus.ERROR, failure = answered.kind))
                    is Answer.Done -> it.copy(
                        preview = shown.copy(status = PreviewStatus.READY, base64 = Base64.encode(answered.value.bytes), mimeType = answered.value.mimeType),
                    )
                }
            }
        }
    }

    /** Reads what deleting reaches, then (once [confirmed]) deletes the item and asks the screen to close. */
    private fun delete(confirmed: Boolean) {
        if (writeJob?.isActive == true) return
        if (!confirmed) {
            update { it.copy(deletion = DeletionView(loading = true, failure = null, impact = null, deleting = false)) }
        } else if (state.value.deletion?.impact == null) {
            return
        } else {
            update { it.copy(deletion = it.deletion?.copy(deleting = true)) }
        }
        writeJob = viewModelScope.launch {
            if (confirmed) {
                val deleted = answer { writes.delete(itemId) }
                ensureActive()
                when (deleted) {
                    is Answer.Rejected -> update { it.copy(deletion = it.deletion?.copy(deleting = false, failure = deleted.kind)) }
                    is Answer.Done -> {
                        update { it.copy(deleted = true, deletion = null) }
                        emit(ItemEffect.Close)
                    }
                }
            } else {
                val impact = answer { reads.deleteImpact(itemId) }
                ensureActive()
                update {
                    when (impact) {
                        is Answer.Rejected -> it.copy(deletion = DeletionView(false, impact.kind, null, false))
                        is Answer.Done -> it.copy(deletion = DeletionView(false, null, impact.value.toView(), false))
                    }
                }
            }
        }
    }
}
