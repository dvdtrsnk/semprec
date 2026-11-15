package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.CollectionPage
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.OpenCollection
import cz.semprec.app.domain.OpenedCollection
import cz.semprec.app.domain.PropertyKind
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** What the last answers hold: the database, the loaded items and where the next page starts. */
private class Loaded(val opened: OpenedCollection, val items: List<CollectionItem>, val nextCursor: String?)

/**
 * One collection of any database: a list, gallery or board of its items, with the quick filters, search, order and
 * filter sheet the server's schema offers. It is configured, not subclassed: Projects, People, Companies, Events and
 * Files are this same ViewModel over different databases and scopes. A newer query supersedes an older one, and an
 * answer that arrives after the ViewModel was closed or superseded is dropped.
 */
class CollectionViewModel internal constructor(
    private val config: CollectionConfig,
    private val openCollection: OpenCollection,
    private val reads: CollectionReads,
    private val writes: CollectionWrites,
) : ScreenViewModel<CollectionState, CollectionAction, CollectionEffect>(CollectionState()) {
    private var inputs = Inputs()
    private var loaded: Loaded? = null
    private var facets: List<FacetResult> = emptyList()
    private var loadJob: Job? = null
    private var moreJob: Job? = null
    private var sheetJob: Job? = null
    private var writeJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: CollectionAction) {
        if (isClosed) return
        when (action) {
            CollectionAction.Retry -> load()
            CollectionAction.Refresh -> query()
            is CollectionAction.Search -> change { copy(search = action.text.trim()) }
            is CollectionAction.SelectQuickFilter -> change { copy(quickKey = action.key) }
            is CollectionAction.SelectSort -> loaded?.let { current ->
                change { sorted(action.axis, current.opened.database) }
            }
            is CollectionAction.SelectLayout -> relayout(action.layout)
            CollectionAction.OpenFilters -> {
                update { it.copy(filterSheet = FilterSheet(loading = true, failure = null, groups = emptyList())) }
                loadFacets()
            }
            CollectionAction.CloseFilters -> update { it.copy(filterSheet = null) }
            is CollectionAction.ToggleFilter ->
                change { copy(selections = selections.toggled(action.propertyKey, action.value)) }
            is CollectionAction.ToggleDatePreset ->
                change { copy(selections = selections.presetToggled(action.propertyKey, action.preset)) }
            is CollectionAction.ClearFilter -> change { copy(selections = selections.cleared(action.propertyKey)) }
            CollectionAction.ClearFilters -> change { copy(selections = Selections()) }
            CollectionAction.LoadMore -> loadMore()
            is CollectionAction.OpenItem -> emit(CollectionEffect.OpenItem(action.id, loaded?.opened?.database?.key))
            is CollectionAction.Create -> create(action.title.trim())
            is CollectionAction.Upload -> upload(action)
            CollectionAction.DismissWriteFailure -> update { it.copy(writeFailure = null) }
        }
    }

    /** Opens the database and runs the first query; also what a retry after a failure does. */
    private fun load() {
        loadJob?.cancel()
        moreJob?.cancel()
        sheetJob?.cancel()
        writeJob?.cancel()
        loaded = null
        facets = emptyList()
        update { CollectionState() }
        loadJob = viewModelScope.launch {
            val opening = answer { openCollection(config.databaseKey, config.databaseId, config.scope) }
            ensureActive()
            when (opening) {
                is Answer.Rejected -> update { collectionFailure(opening.kind) }
                is Answer.Done -> {
                    val database = opening.value.database
                    val chip = database.quickFilters.firstOrNull { it.isDefault } ?: database.quickFilters.firstOrNull()
                    inputs = Inputs(quickKey = chip?.key)
                    val page = answer { reads.query(database, inputs.queryOf(config, database, null)) }
                    ensureActive()
                    publish(opening.value, page, previous = emptyList())
                }
            }
        }
    }

    /** Runs the current inputs again from the first page, over the rows that are still shown. */
    private fun query() {
        val current = loaded ?: return
        loadJob?.cancel()
        moreJob?.cancel()
        update { it.copy(refreshing = true) }
        loadJob = viewModelScope.launch {
            val database = current.opened.database
            val page = answer { reads.query(database, inputs.queryOf(config, database, null)) }
            ensureActive()
            publish(current.opened, page, previous = emptyList())
            if (state.value.filterSheet != null) loadFacets()
        }
    }

    private fun change(transform: Inputs.() -> Inputs) {
        inputs = inputs.transform()
        query()
    }

    private fun relayout(layout: CollectionLayout) {
        val current = loaded ?: return
        if (layout !in state.value.layouts) return
        inputs = inputs.copy(layout = layout)
        update { collectionState(current.opened, current.items, current.nextCursor, inputs, facets, it) }
    }

    private fun loadMore() {
        val current = loaded ?: return
        val cursor = current.nextCursor ?: return
        if (moreJob?.isActive == true || loadJob?.isActive == true) return
        update { it.copy(loadingMore = true) }
        moreJob = viewModelScope.launch {
            val database = current.opened.database
            val page = answer { reads.query(database, inputs.queryOf(config, database, cursor)) }
            ensureActive()
            when (page) {
                is Answer.Rejected -> update { it.copy(loadingMore = false) }
                is Answer.Done -> publish(current.opened, page, previous = current.items)
            }
        }
    }

    private fun loadFacets() {
        val current = loaded ?: return
        sheetJob?.cancel()
        val database = current.opened.database
        val keys = database.filterProperties().filter { it.kind != PropertyKind.DATE }.map { it.key }
        sheetJob = viewModelScope.launch {
            val answered = answer { reads.facets(database, inputs.queryOf(config, database, null), keys) }
            ensureActive()
            if (state.value.filterSheet == null) return@launch
            when (answered) {
                is Answer.Rejected -> update { it.copy(filterSheet = FilterSheet(false, answered.kind, emptyList())) }
                is Answer.Done -> {
                    facets = answered.value
                    update { it.copy(filterSheet = FilterSheet(false, null, filterGroups(database, facets, inputs.selections))) }
                }
            }
        }
    }

    private fun create(title: String) {
        val current = loaded ?: return
        if (title.isEmpty() || writeJob?.isActive == true) return
        update { it.copy(creating = true, writeFailure = null) }
        writeJob = viewModelScope.launch {
            val database = current.opened.database
            val created = answer { writes.create(database, title, config.relationFor(database)) }
            ensureActive()
            when (created) {
                is Answer.Rejected -> update { it.copy(creating = false, writeFailure = WriteFailure(created.kind)) }
                is Answer.Done -> {
                    update { it.copy(creating = false) }
                    emit(CollectionEffect.OpenItem(created.value.id, database.key))
                }
            }
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun upload(action: CollectionAction.Upload) {
        val current = loaded ?: return
        if (writeJob?.isActive == true) return
        val bytes = try {
            Base64.decode(action.base64)
        } catch (_: IllegalArgumentException) {
            update { it.copy(writeFailure = WriteFailure(FailureKind.INVALID_DATA)) }
            return
        }
        update { it.copy(creating = true, writeFailure = null) }
        writeJob = viewModelScope.launch {
            val relation = config.relationFor(current.opened.database)
            val saved = answer { writes.upload(action.filename, action.mimeType, bytes, relation) }
            ensureActive()
            when (saved) {
                is Answer.Rejected -> update { it.copy(creating = false, writeFailure = WriteFailure(saved.kind)) }
                is Answer.Done -> {
                    update { it.copy(creating = false) }
                    query()
                }
            }
        }
    }

    private fun publish(opened: OpenedCollection, page: Answer<CollectionPage>, previous: List<CollectionItem>) {
        when (page) {
            is Answer.Rejected -> update { collectionFailure(page.kind, opened.database) }
            is Answer.Done -> {
                val items = previous + page.value.items
                loaded = Loaded(opened, items, page.value.nextCursor)
                update { collectionState(opened, items, page.value.nextCursor, inputs, facets, it) }
            }
        }
    }
}
