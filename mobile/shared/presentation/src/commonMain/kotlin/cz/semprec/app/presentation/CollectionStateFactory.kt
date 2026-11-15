package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.OpenedCollection

internal fun CollectionDatabase.header() = CollectionHeader(id, key, name, icon, color, searchPlaceholder)

/** What the screen shows for [items] under [inputs]; the filter sheet, creation and write failure carry over. */
internal fun collectionState(
    opened: OpenedCollection,
    items: List<CollectionItem>,
    nextCursor: String?,
    inputs: Inputs,
    facets: List<FacetResult>,
    previous: CollectionState,
): CollectionState {
    val database = opened.database
    val rows = items.map { it.toRow(database) }
    val layouts = database.layouts()
    val layout = inputs.layout.takeIf { it in layouts } ?: CollectionLayout.LIST
    val first = inputs.sortOf(database).firstOrNull()
    val axis = inputs.axis ?: first?.let(database::axisOf)
    return CollectionState(
        phase = if (rows.isEmpty()) CollectionPhase.EMPTY else CollectionPhase.CONTENT,
        header = database.header(),
        search = inputs.search,
        quickFilters = database.quickFilters.map { QuickFilterChip(it.key, it.label) },
        selectedQuickFilter = inputs.quickKey,
        sorts = database.sorts(),
        selectedSort = axis,
        descending = if (inputs.axis != null) inputs.descending else first?.descending ?: false,
        layouts = layouts,
        layout = layout,
        sections = sectionsOf(rows, database, layout, axis, opened.today),
        filterSheet = previous.filterSheet?.copy(groups = filterGroups(database, facets, inputs.selections)),
        activeFilterCount = inputs.selections.count,
        hasMore = nextCursor != null,
        canCreate = database.title != null && database.fileProperty() == null,
        canUpload = database.fileProperty() != null,
        creating = previous.creating,
        writeFailure = previous.writeFailure,
    )
}

/** A collection that could not be shown: [kind] is `null` for an unexpected failure. */
internal fun collectionFailure(kind: FailureKind?, database: CollectionDatabase? = null) =
    CollectionState(phase = CollectionPhase.ERROR, failure = kind, header = database?.header())
