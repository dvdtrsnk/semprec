package cz.alldots.app.data

import cz.alldots.app.domain.FacetResult
import cz.alldots.app.domain.FacetValue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** `POST /api/databases/:id/facets`. A path facet (no `property`) is never requested by the app and is skipped. */
@Serializable
internal data class FacetsDto(val facets: List<FacetDto> = emptyList()) {
    fun toDomain(): List<FacetResult> = facets.mapNotNull { facet ->
        facet.property?.let { FacetResult(it, facet.values.map(FacetValueDto::toDomain)) }
    }
}

@Serializable
internal data class FacetDto(val property: String? = null, val values: List<FacetValueDto> = emptyList())

@Serializable
internal data class FacetValueDto(
    val value: JsonElement? = null,
    val label: String? = null,
    val color: String? = null,
    val count: Int = 0,
) {
    /** A choice's value is a key or an item id (text); the choice of items without a value has none. */
    fun toDomain(): FacetValue = FacetValue((value as? JsonPrimitive)?.contentOrNull, label, color, count)
}
