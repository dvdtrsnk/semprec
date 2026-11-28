package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class CollectionPhase { LOADING, CONTENT, EMPTY, ERROR }

/** How a collection is laid out: rows, tiles, or one column per status. */
enum class CollectionLayout { LIST, GALLERY, BOARD }

/** What a collection can be ordered by; [CREATED] is the order of an item's creation. */
enum class SortAxis { TITLE, DATE, GROUP, CREATED }

/** What a section of the list is keyed by. [PAST] and [NO_VALUE] carry the server's own headings in the label. */
enum class SectionKind { NONE, OPTION, DAY, MONTH, LETTER, PAST, NO_VALUE }

/** The collection being shown: [name] and [searchPlaceholder] are in the language of the signed-in person. */
data class CollectionHeader(
    val databaseId: String,
    val key: String?,
    val name: String,
    val icon: String?,
    val color: String?,
    val searchPlaceholder: String?,
)

data class QuickFilterChip(val key: String, val label: String)

/** An order the person can pick; [name] is the name of the property it orders by (empty for [SortAxis.CREATED]). */
data class SortChoice(val axis: SortAxis, val name: String)

/**
 * One item of a list. [group] is the value of the status-like select property, [date] the item's date property,
 * [subtitle] up to three values worth showing under the title, [rating] the person's own stars (1 to 5) of a book,
 * a film or the like.
 */
data class CollectionRow(
    val id: String,
    val title: String,
    val group: OptionView?,
    val date: String?,
    val subtitle: List<FieldContent>,
    val fileType: String?,
    val rating: Int? = null,
)

/** A group of rows under one heading; [label] is empty for a heading the app words itself (a day, a month). */
data class CollectionSection(
    val kind: SectionKind,
    val key: String,
    val label: String,
    val color: String?,
    val rows: List<CollectionRow>,
)

/** One choice of the filter sheet. [count] is `null` where the server counts nothing (a relative date). */
data class FilterOption(
    val value: String,
    val label: String,
    val color: String?,
    val count: Int?,
    val selected: Boolean,
)

data class FilterGroup(
    val propertyKey: String,
    val name: String,
    val kind: FieldKind,
    val options: List<FilterOption>,
)

/**
 * The chips above the list, one per value of the database's facet bar property that items hold. A chip toggles its
 * value in the same selection the filter sheet edits ([CollectionAction.Filter.Toggle] with [propertyKey]).
 */
data class FacetBar(val propertyKey: String, val chips: List<FilterOption>)

/** What the filter sheet shows once it was opened: its groups, or why they are missing. */
data class FilterSheet(val loading: Boolean, val failure: Failed?, val groups: List<FilterGroup>)

/**
 * Everything one collection screen shows. [facetBar] is `null` when the database declares no bar or no item holds a
 * value of it; [refreshing] is true while a new query runs over the rows still on screen; [creating] while a new item
 * or an uploaded file is saved; [writeFailure] is the last write that failed.
 */
data class CollectionState(
    val phase: CollectionPhase = CollectionPhase.LOADING,
    val failure: FailureKind? = null,
    val header: CollectionHeader? = null,
    val search: String = "",
    val quickFilters: List<QuickFilterChip> = emptyList(),
    val selectedQuickFilter: String? = null,
    val sorts: List<SortChoice> = emptyList(),
    val selectedSort: SortAxis? = null,
    val descending: Boolean = false,
    val layouts: List<CollectionLayout> = listOf(CollectionLayout.LIST),
    val layout: CollectionLayout = CollectionLayout.LIST,
    val sections: List<CollectionSection> = emptyList(),
    val filterSheet: FilterSheet? = null,
    val facetBar: FacetBar? = null,
    val activeFilterCount: Int = 0,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val refreshing: Boolean = false,
    val canCreate: Boolean = false,
    val canUpload: Boolean = false,
    val creating: Boolean = false,
    val writeFailure: Failed? = null,
)
