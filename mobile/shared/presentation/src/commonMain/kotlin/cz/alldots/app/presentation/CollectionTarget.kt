package cz.alldots.app.presentation

import cz.alldots.app.domain.CollectionScope
import cz.alldots.app.domain.FilterTree

/**
 * Which collection a screen shows: a database, named by its canonical key or, for a database a person created, by its
 * id, and the items of it that belong. Projects, People, Companies, Events and Files are this one screen over
 * different targets.
 */
sealed interface CollectionTarget {
    val databaseKey: String?
    val databaseId: String?

    /** Every item of the database. */
    data class Whole(override val databaseKey: String?, override val databaseId: String?) : CollectionTarget

    /** The items whose relation [relationKey] holds the item [itemId] (the files of a project). */
    data class OfItem(override val databaseKey: String, val relationKey: String, val itemId: String) :
        CollectionTarget {
        override val databaseId: String? get() = null
    }

    /** The items a filter selects, such as the one a related collection of an item carries. */
    data class Matching(
        override val databaseKey: String?,
        override val databaseId: String?,
        val filterJson: String,
    ) : CollectionTarget
}

internal fun CollectionTarget.toConfig(): CollectionConfig = CollectionConfig(
    databaseKey = databaseKey,
    databaseId = databaseId,
    scope = when (this) {
        is CollectionTarget.Whole -> CollectionScope.Everything
        is CollectionTarget.OfItem -> CollectionScope.Related(relationKey, itemId)
        is CollectionTarget.Matching -> CollectionScope.Matching(FilterTree(filterJson))
    },
)
