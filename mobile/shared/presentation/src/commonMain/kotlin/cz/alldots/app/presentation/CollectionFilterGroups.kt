package cz.alldots.app.presentation

import cz.alldots.app.domain.CollectionDatabase
import cz.alldots.app.domain.CollectionProperty
import cz.alldots.app.domain.FacetResult
import cz.alldots.app.domain.FacetSelection
import cz.alldots.app.domain.PropertyKind

/** The relative dates the filter sheet offers for a date property; the server evaluates them in the tenant's zone. */
internal val DATE_PRESETS = listOf(
    "today",
    "tomorrow",
    "thisWeek",
    "nextWeek",
    "thisMonth",
    "upcoming",
    "past",
    "last7",
    "last30",
    "thisYear",
)

/** What the person chose in the filter sheet, by property: option keys or item ids, or one relative date. */
internal data class Selections(
    val values: Map<String, List<String>> = emptyMap(),
    val presets: Map<String, String> = emptyMap(),
) {
    val count: Int get() = (values.filterValues { it.isNotEmpty() }.keys + presets.keys).size

    fun toggled(propertyKey: String, value: String): Selections {
        val current = values[propertyKey].orEmpty()
        val next = if (value in current) current - value else current + value
        return copy(values = values + (propertyKey to next))
    }

    fun presetToggled(propertyKey: String, preset: String): Selections =
        if (presets[propertyKey] == preset) copy(presets = presets - propertyKey)
        else copy(presets = presets + (propertyKey to preset))

    fun cleared(propertyKey: String): Selections = copy(values = values - propertyKey, presets = presets - propertyKey)

    fun toDomain(): List<FacetSelection> =
        values.filterValues { it.isNotEmpty() }.map { (key, chosen) -> FacetSelection.OneOf(key, chosen) } +
            presets.map { (key, preset) -> FacetSelection.DatePreset(key, preset) }
}

/** The groups of the filter sheet: the server's counts for selects and relations, fixed presets for the date. */
internal fun filterGroups(
    database: CollectionDatabase,
    facets: List<FacetResult>,
    selections: Selections,
): List<FilterGroup> = database.filterProperties().mapNotNull { property ->
    val kind = property.fieldKind() ?: return@mapNotNull null
    val options = if (property.kind == PropertyKind.DATE) {
        DATE_PRESETS.map { FilterOption(it, it, null, null, selections.presets[property.key] == it) }
    } else {
        facetOptions(property, facets.firstOrNull { it.propertyKey == property.key }, selections)
    }
    if (options.isEmpty()) null else FilterGroup(property.key, property.name, kind, options)
}

/**
 * The chips above the list: the values of the database's facet bar property that items hold, from the bar's own
 * facet, each selected when the filter sheet's selection holds it. `null` when the database declares no bar, or when
 * no item holds any of its values.
 */
internal fun facetBar(database: CollectionDatabase, facet: FacetResult?, selections: Selections): FacetBar? {
    val property = database.facetBarProperty?.let(database::property) ?: return null
    val chips = facetOptions(property, facet, selections)
    return if (chips.isEmpty()) null else FacetBar(property.key, chips)
}

/** The choices of [facet] that items hold, labelled by the server or else by the property's own options. */
private fun facetOptions(
    property: CollectionProperty,
    facet: FacetResult?,
    selections: Selections,
): List<FilterOption> {
    val chosen = selections.values[property.key].orEmpty()
    return facet?.values.orEmpty()
        .filter { it.value != null && it.count > 0 }
        .map { value ->
            val key = value.value.orEmpty()
            val label = value.label ?: property.options.firstOrNull { it.key == key }?.label ?: key
            val color = value.color ?: property.options.firstOrNull { it.key == key }?.color
            FilterOption(key, label, color, value.count, key in chosen)
        }
}
