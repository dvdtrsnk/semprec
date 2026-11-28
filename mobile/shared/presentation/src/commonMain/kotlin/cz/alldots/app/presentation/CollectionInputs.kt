package cz.alldots.app.presentation

import cz.alldots.app.domain.CollectionDatabase
import cz.alldots.app.domain.CollectionQuery
import cz.alldots.app.domain.CollectionScope
import cz.alldots.app.domain.SortSpec

/** Which collection a screen shows: a database by key or id, narrowed by a scope. */
internal data class CollectionConfig(
    val databaseKey: String?,
    val databaseId: String?,
    val scope: CollectionScope,
)

/** What the person chose on screen; every query is built from this and the database. */
internal data class Inputs(
    val quickKey: String? = null,
    val axis: SortAxis? = null,
    val descending: Boolean = false,
    val layout: CollectionLayout? = null,
    val selections: Selections = Selections(),
    val search: String = "",
) {
    /** The quick filter chosen now. */
    fun chip(database: CollectionDatabase) = database.quickFilters.firstOrNull { it.key == quickKey }

    /** The order the query asks for: the person's choice, else the chip's own order, else the database's default. */
    fun sortOf(database: CollectionDatabase): List<SortSpec> {
        val chosen = axis?.let { database.sortSpec(it, descending) }
        return listOfNotNull(chosen).ifEmpty { chip(database)?.sort.orEmpty().ifEmpty { listOf(database.defaultSort) } }
    }

    /** The first page, or the page after [cursor], of this collection. */
    fun queryOf(config: CollectionConfig, database: CollectionDatabase, cursor: String?) = CollectionQuery(
        scope = config.scope,
        quickFilter = chip(database)?.filter,
        selections = selections.toDomain(),
        search = search.ifEmpty { null },
        sort = sortOf(database),
        cursor = cursor,
        expand = database.contextRelations().map { it.key },
    )

    /**
     * The inputs after a tap on [tapped]: an axis that is not active yet starts in its natural direction (the
     * database's default direction when it is the default axis, else ascending), the active one reverses.
     */
    fun sorted(tapped: SortAxis, database: CollectionDatabase): Inputs {
        val first = sortOf(database).firstOrNull()
        val activeAxis = axis ?: first?.let(database::axisOf)
        val activeDescending = if (axis != null) descending else first?.descending ?: false
        if (activeAxis == tapped) return copy(axis = tapped, descending = !activeDescending)
        val natural = database.defaultSort.takeIf { database.axisOf(it) == tapped }?.descending ?: false
        return copy(axis = tapped, descending = natural)
    }
}

/** What a new item or an uploaded file is attached to: the item it hangs on, when the collection is related to one. */
internal fun CollectionConfig.relationFor(): Pair<String, String>? = when (scope) {
    is CollectionScope.Related -> scope.propertyKey to scope.itemId
    CollectionScope.Everything, is CollectionScope.Matching -> null
}
