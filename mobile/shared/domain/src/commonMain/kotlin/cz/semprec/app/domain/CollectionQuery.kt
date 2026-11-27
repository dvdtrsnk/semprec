package cz.semprec.app.domain

/** Which items of a database a collection shows beyond its own filter: all, those related to one item, or a filter's. */
sealed interface CollectionScope {
    data object Everything : CollectionScope

    /** The items whose relation [propertyKey] contains [itemId] (the files of a project, the people of a company). */
    data class Related(val propertyKey: String, val itemId: String) : CollectionScope

    /** The items a filter selects, such as the one a related collection of an item carries. */
    data class Matching(val filter: FilterTree) : CollectionScope
}

/** What the person narrowed a collection by in the filter sheet. The data layer turns each into a filter condition. */
sealed interface FacetSelection {
    val propertyKey: String

    /** Any of the chosen option keys (select, multi-select) or item ids (relation). */
    data class OneOf(override val propertyKey: String, val values: List<String>) : FacetSelection

    /** A relative date such as `today`, `thisWeek` or `last30`, evaluated by the server in the tenant's time zone. */
    data class DatePreset(override val propertyKey: String, val preset: String) : FacetSelection

    data class Checked(override val propertyKey: String, val on: Boolean) : FacetSelection
}

/**
 * One request for items. [quickFilter] and [selections] are ANDed with the database's own collection filter and the
 * [scope]; [search] is plain text matched by the server; [expand] names the relation properties whose targets come
 * back with the items (at most five).
 */
data class CollectionQuery(
    val scope: CollectionScope = CollectionScope.Everything,
    val quickFilter: FilterTree? = null,
    val selections: List<FacetSelection> = emptyList(),
    val search: String? = null,
    val sort: List<SortSpec> = emptyList(),
    val cursor: String? = null,
    val limit: Int = DEFAULT_PAGE_SIZE,
    val expand: List<String> = emptyList(),
) {
    companion object {
        const val DEFAULT_PAGE_SIZE = 50
    }
}

data class CollectionPage(val items: List<CollectionItem>, val nextCursor: String?)

/** One choice of a facet. [value] is `null` for the items without a value; [count] is how many items hold it. */
data class FacetValue(val value: String?, val label: String?, val color: String?, val count: Int)

data class FacetResult(val propertyKey: String, val values: List<FacetValue>)
