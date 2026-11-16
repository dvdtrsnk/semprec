package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.FacetSelection
import cz.semprec.app.domain.PropertyKind

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
        val chosen = selections.values[property.key].orEmpty()
        facets.firstOrNull { it.propertyKey == property.key }?.values.orEmpty()
            .filter { it.value != null && it.count > 0 }
            .map { facet ->
                val key = facet.value.orEmpty()
                val label = facet.label ?: property.options.firstOrNull { it.key == key }?.label ?: key
                val color = facet.color ?: property.options.firstOrNull { it.key == key }?.color
                FilterOption(key, label, color, facet.count, key in chosen)
            }
    }
    if (options.isEmpty()) null else FilterGroup(property.key, property.name, kind, options)
}
