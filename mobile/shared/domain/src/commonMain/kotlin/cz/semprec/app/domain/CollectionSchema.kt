package cz.semprec.app.domain

/**
 * A filter tree of the backend's filter grammar, kept as the JSON text the server declared or understands. Only the
 * data layer reads or builds one; everything else passes it on.
 */
data class FilterTree(val json: String)

/** What a property holds, as far as a screen draws or edits it differently. [OTHER] is shown as nothing. */
enum class PropertyKind {
    TITLE,
    TEXT,
    LONG_TEXT,
    NUMBER,
    SELECT,
    MULTI_SELECT,
    DATE,
    TIME,
    CHECKBOX,
    RELATION,
    FILE,
    IMAGE,
    URL,
    COLOR,
    OTHER,
}

/** One choice of a select property; [label] is already in the language of the signed-in person. */
data class PropertyOption(val key: String, val label: String, val color: String?)

/**
 * One property of a database. [system] is true for a property the system or a module owns: the person does not
 * edit it. [targetDatabaseId] is set for a relation.
 */
data class CollectionProperty(
    val id: String,
    val key: String,
    val name: String,
    val kind: PropertyKind,
    val options: List<PropertyOption>,
    val targetDatabaseId: String?,
    val system: Boolean,
    val filterable: Boolean,
)

/** An order by a property of the database, or by an item timestamp ([systemKey] is `createdAt` or `updatedAt`). */
data class SortSpec(val propertyKey: String?, val systemKey: String?, val descending: Boolean)

/** A chip of the collection: a named filter, optionally with its own order; [filter] is `null` for "everything". */
data class QuickFilter(
    val key: String,
    val label: String,
    val filter: FilterTree?,
    val sort: List<SortSpec>,
    val isDefault: Boolean,
)

/** The headings of a date-grouped collection for items before today and for items without a date. */
data class DateLabels(val past: String, val noDate: String)

/**
 * One database as `/api/schema` describes it. [collectionFilter] selects the items that belong in the collection,
 * [pickerFilter] the items a picker of this database offers by default. [facetBarProperty] is the key of the select or
 * multi-select property whose values the collection shows as a bar of chips above its list (`null` for no bar).
 */
data class CollectionDatabase(
    val id: String,
    val key: String?,
    val name: String,
    val icon: String?,
    val color: String?,
    val searchPlaceholder: String?,
    val properties: List<CollectionProperty>,
    val quickFilters: List<QuickFilter>,
    val defaultSort: SortSpec,
    val dateLabels: DateLabels?,
    val collectionFilter: FilterTree?,
    val pickerFilter: FilterTree?,
    val facetBarProperty: String? = null,
) {
    val title: CollectionProperty? get() = properties.firstOrNull { it.kind == PropertyKind.TITLE }

    fun property(key: String): CollectionProperty? = properties.firstOrNull { it.key == key }

    /**
     * The relation properties that say where an item belongs and who it involves, in the order they are expanded
     * (at most five can be expanded in one read). Other relations (a project's tasks, a company's files) are the item's
     * related collections.
     */
    fun contextRelations(): List<CollectionProperty> =
        CONTEXT_RELATIONS.mapNotNull { key -> property(key)?.takeIf { it.kind == PropertyKind.RELATION } }
            .take(MAX_EXPANDED_RELATIONS)
}

/** The keys of the context relations, in the order they are expanded and shown in. */
val CONTEXT_RELATIONS: List<String> = listOf("project", "projects", "company", "companies", "people")

private const val MAX_EXPANDED_RELATIONS = 5

/** The databases the server has, and the calendar day of the tenant (`YYYY-MM-DD`). */
data class CollectionSchema(val today: String, val databases: List<CollectionDatabase>) {
    fun database(key: String): CollectionDatabase? = databases.firstOrNull { it.key == key }

    fun databaseById(id: String): CollectionDatabase? = databases.firstOrNull { it.id == id }
}
