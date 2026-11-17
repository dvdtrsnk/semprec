package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * One collection of any database: a list, gallery or board of its items, with the quick filters, search, order and
 * filter sheet the server's schema offers. It is configured, not subclassed: Projects, People, Companies, Events and
 * Files are this same ViewModel over different targets. A newer query supersedes an older one, and an answer that
 * arrives after the ViewModel was closed or superseded is dropped.
 */
class CollectionViewModel internal constructor(
    private val config: CollectionConfig,
    private val openCollection: OpenCollection,
    private val reads: CollectionReads,
    writes: CollectionWrites,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<CollectionState, CollectionAction, CollectionEffect>(CollectionState()) {
    private var inputs = Inputs()
    private var loaded: CollectionLoaded? = null
    private var facets: List<FacetResult> = emptyList()
    private var loadJob: Job? = null
    private var moreJob: Job? = null
    private var sheetJob: Job? = null
    private val host =
        FlowHost<CollectionState, CollectionEffect>(viewModelScope, { state.value }, { update(it) }, { emit(it) })
    private val adding = CollectionWriteFlow(host, writes, config, { loaded?.opened?.database }, ::query)

    init {
        reloadOnChanges(changes) { onAction(CollectionAction.Refresh) }
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
            CollectionAction.LoadMore -> loadMore()
            is CollectionAction.OpenItem -> emit(CollectionEffect.OpenItem(action.id, loaded?.opened?.database?.key))
            CollectionAction.DismissWriteFailure -> update { it.copy(writeFailure = null) }
            is CollectionAction.Filter -> filter(action)
            is CollectionAction.Write -> adding.handle(action)
        }
    }

    /** Opens the database and runs the first query; also what a retry after a failure does. */
    private fun load() {
        loadJob?.cancel()
        moreJob?.cancel()
        sheetJob?.cancel()
        adding.cancel()
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
        update { collectionState(current, inputs, facets, it) }
    }

    private fun loadMore() {
        val current = loaded
        val cursor = current?.nextCursor
        val busy = moreJob?.isActive == true || loadJob?.isActive == true
        if (current == null || cursor == null || busy) return
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

    private fun filter(action: CollectionAction.Filter) {
        when (action) {
            CollectionAction.Filter.Open -> {
                update { it.copy(filterSheet = FilterSheet(loading = true, failure = null, groups = emptyList())) }
                loadFacets()
            }
            CollectionAction.Filter.Close -> update { it.copy(filterSheet = null) }
            is CollectionAction.Filter.Toggle ->
                change { copy(selections = selections.toggled(action.propertyKey, action.value)) }
            is CollectionAction.Filter.ToggleDate ->
                change { copy(selections = selections.presetToggled(action.propertyKey, action.preset)) }
            is CollectionAction.Filter.Clear -> change { copy(selections = selections.cleared(action.propertyKey)) }
            CollectionAction.Filter.ClearAll -> change { copy(selections = Selections()) }
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
                is Answer.Rejected ->
                    update { it.copy(filterSheet = FilterSheet(false, Failed(answered.kind), emptyList())) }
                is Answer.Done -> {
                    facets = answered.value
                    val groups = filterGroups(database, facets, inputs.selections)
                    update { it.copy(filterSheet = FilterSheet(false, null, groups)) }
                }
            }
        }
    }

    private fun publish(opened: OpenedCollection, page: Answer<CollectionPage>, previous: List<CollectionItem>) {
        when (page) {
            is Answer.Rejected -> update { collectionFailure(page.kind, opened.database) }
            is Answer.Done -> {
                val now = CollectionLoaded(opened, previous + page.value.items, page.value.nextCursor)
                loaded = now
                update { collectionState(now, inputs, facets, it) }
            }
        }
    }
}
