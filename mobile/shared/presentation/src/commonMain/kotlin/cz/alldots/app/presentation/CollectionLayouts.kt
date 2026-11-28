package cz.alldots.app.presentation

import cz.alldots.app.domain.CONTEXT_RELATIONS
import cz.alldots.app.domain.CollectionDatabase
import cz.alldots.app.domain.CollectionProperty
import cz.alldots.app.domain.PropertyKind
import cz.alldots.app.domain.SortSpec

private val GROUP_KEYS = listOf("status", "type", "relationship")
private const val CREATED_AT = "createdAt"

/** The select property that splits the collection into columns and sections: its status, type or relationship. */
internal fun CollectionDatabase.groupProperty(): CollectionProperty? =
    GROUP_KEYS.firstNotNullOfOrNull { key ->
        property(key)?.takeIf { it.kind == PropertyKind.SELECT && it.options.size > 1 }
    }

/** The item's date: the first date property the person can edit, else the first one. */
internal fun CollectionDatabase.dateProperty(): CollectionProperty? {
    val dates = properties.filter { it.kind == PropertyKind.DATE }
    return dates.firstOrNull { !it.system } ?: dates.firstOrNull()
}

/** The picture or document of an item, which makes its collection worth showing as tiles. */
internal fun CollectionDatabase.fileProperty(): CollectionProperty? =
    properties.firstOrNull { it.kind == PropertyKind.FILE || it.kind == PropertyKind.IMAGE }

/**
 * The document an item is made of, as a file of Files is: a new item of its collection is an uploaded file. A picture
 * (the cover of a book, the photo of a recipe) only describes an item that is created by its name.
 */
internal fun CollectionDatabase.uploadProperty(): CollectionProperty? =
    properties.firstOrNull { it.kind == PropertyKind.FILE }

internal fun CollectionDatabase.layouts(): List<CollectionLayout> = buildList {
    add(CollectionLayout.LIST)
    if (fileProperty() != null) add(CollectionLayout.GALLERY)
    if (groupProperty() != null) add(CollectionLayout.BOARD)
}

private val GALLERY_FIRST_KEYS = setOf("books", "movies", "recipes")

/** The layout a collection opens in: tiles for what is browsed by its cover or photo, rows for everything else. */
internal fun CollectionDatabase.defaultLayout(layouts: List<CollectionLayout>): CollectionLayout =
    if (key in GALLERY_FIRST_KEYS && CollectionLayout.GALLERY in layouts) {
        CollectionLayout.GALLERY
    } else {
        CollectionLayout.LIST
    }

internal fun CollectionDatabase.sorts(): List<SortChoice> = buildList {
    title?.let { add(SortChoice(SortAxis.TITLE, it.name)) }
    dateProperty()?.let { add(SortChoice(SortAxis.DATE, it.name)) }
    groupProperty()?.let { add(SortChoice(SortAxis.GROUP, it.name)) }
}

/** The order [axis] stands for in this database, or `null` when the database has nothing to order by. */
internal fun CollectionDatabase.sortSpec(axis: SortAxis, descending: Boolean): SortSpec? = when (axis) {
    SortAxis.TITLE -> title?.let { SortSpec(it.key, null, descending) }
    SortAxis.DATE -> dateProperty()?.let { SortSpec(it.key, null, descending) }
    SortAxis.GROUP -> groupProperty()?.let { SortSpec(it.key, null, descending) }
    SortAxis.CREATED -> SortSpec(null, CREATED_AT, descending)
}

/** The axis an order of the server's belongs to, or `null` for an order the app has no name for. */
internal fun CollectionDatabase.axisOf(spec: SortSpec): SortAxis? = when {
    spec.systemKey == CREATED_AT -> SortAxis.CREATED
    spec.propertyKey == null -> null
    spec.propertyKey == title?.key -> SortAxis.TITLE
    spec.propertyKey == dateProperty()?.key -> SortAxis.DATE
    spec.propertyKey == groupProperty()?.key -> SortAxis.GROUP
    else -> null
}

/**
 * The properties the filter sheet offers: status-like selects, multi-selects and the context relations. The property
 * of the facet bar is offered even while the schema read with the screen knew none of its choices, so that a chip
 * chosen in the bar is always in the sheet too.
 */
internal fun CollectionDatabase.filterProperties(): List<CollectionProperty> = properties.filter { property ->
    when (property.kind) {
        PropertyKind.SELECT, PropertyKind.MULTI_SELECT ->
            property.filterable && (property.options.isNotEmpty() || property.key == facetBarProperty)
        PropertyKind.RELATION -> property.filterable && property.key in CONTEXT_RELATIONS
        PropertyKind.DATE -> property.filterable && property == dateProperty()
        else -> false
    }
}
