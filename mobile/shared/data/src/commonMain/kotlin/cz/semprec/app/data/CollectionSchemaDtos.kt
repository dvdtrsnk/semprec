package cz.semprec.app.data

import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionProperty
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.DateLabels
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.PropertyOption
import cz.semprec.app.domain.QuickFilter
import cz.semprec.app.domain.SortSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** `GET /api/schema`: the calendar day of the tenant and every database with its properties and view hints. */
@Serializable
internal data class SchemaDto(val tenant: TenantDto, val databases: List<SchemaDatabaseDto>) {
    fun toDomain(): CollectionSchema = CollectionSchema(tenant.today, databases.map { it.toDomain() })
}

@Serializable
internal data class TenantDto(val timezone: String = "", val today: String = "")

@Serializable
internal data class SchemaDatabaseDto(
    val databaseId: String,
    val key: String? = null,
    val name: String = "",
    val searchPlaceholder: String? = null,
    val icon: String? = null,
    val color: String? = null,
    val properties: List<SchemaPropertyDto> = emptyList(),
    val quickFilters: List<QuickFilterDto> = emptyList(),
    val defaultSort: SortDto? = null,
    val dateLabels: DateLabelsDto? = null,
    val collectionFilter: JsonElement? = null,
    val pickerFilter: JsonElement? = null,
    val facetBarProperty: String? = null,
) {
    fun toDomain(): CollectionDatabase = CollectionDatabase(
        id = databaseId,
        key = key,
        name = name,
        icon = icon,
        color = color,
        searchPlaceholder = searchPlaceholder,
        properties = properties.map { it.toDomain() },
        quickFilters = quickFilters.map { it.toDomain() },
        defaultSort = defaultSort?.toDomain() ?: SortSpec(null, CREATED_AT, descending = true),
        dateLabels = dateLabels?.let { DateLabels(it.past, it.noDate) },
        collectionFilter = collectionFilter?.let { FilterTree(ApiJson.encodeToString(JsonElement.serializer(), it)) },
        pickerFilter = pickerFilter?.let { FilterTree(ApiJson.encodeToString(JsonElement.serializer(), it)) },
        facetBarProperty = facetBarProperty,
    )
}

@Serializable
internal data class SchemaPropertyDto(
    val id: String,
    val key: String,
    val type: String,
    val name: String = "",
    val owner: String = "user",
    val filterable: Boolean = false,
    val options: List<OptionDto> = emptyList(),
    val config: PropertyConfigDto = PropertyConfigDto(),
) {
    fun toDomain(): CollectionProperty = CollectionProperty(
        id = id,
        key = key,
        name = name,
        kind = propertyKind(type),
        options = options.map { it.toDomain() },
        targetDatabaseId = config.targetDatabaseId,
        system = owner == "system",
        filterable = filterable,
    )
}

@Serializable
internal data class PropertyConfigDto(val targetDatabaseId: String? = null)

@Serializable
internal data class OptionDto(val key: String, val label: String = "", val color: String? = null) {
    fun toDomain(): PropertyOption = PropertyOption(key, label, color)
}

@Serializable
internal data class QuickFilterDto(
    val key: String,
    val label: String = "",
    val filter: JsonElement? = null,
    val sort: List<SortDto> = emptyList(),
    val isDefault: Boolean = false,
) {
    fun toDomain(): QuickFilter = QuickFilter(
        key = key,
        label = label,
        filter = filter?.let { FilterTree(ApiJson.encodeToString(JsonElement.serializer(), it)) },
        sort = sort.map { it.toDomain() },
        isDefault = isDefault,
    )
}

/** A sort as the schema writes it: a property or an item timestamp (`system`), and a direction. */
@Serializable
internal data class SortDto(val property: String? = null, val system: String? = null, val direction: String = "asc") {
    fun toDomain(): SortSpec = SortSpec(property, system, descending = direction == DESCENDING)
}

@Serializable
internal data class DateLabelsDto(val past: String = "", val noDate: String = "")

private const val CREATED_AT = "createdAt"
private const val DESCENDING = "desc"

private val KINDS = mapOf(
    "title" to PropertyKind.TITLE,
    "text" to PropertyKind.TEXT,
    "longText" to PropertyKind.LONG_TEXT,
    "number" to PropertyKind.NUMBER,
    "select" to PropertyKind.SELECT,
    "multi_select" to PropertyKind.MULTI_SELECT,
    "date" to PropertyKind.DATE,
    "time" to PropertyKind.TIME,
    "checkbox" to PropertyKind.CHECKBOX,
    "relation" to PropertyKind.RELATION,
    "file" to PropertyKind.FILE,
    "image" to PropertyKind.IMAGE,
    "url" to PropertyKind.URL,
    "color" to PropertyKind.COLOR,
)

/** The kind a property type of the server is drawn as; a type no screen draws is [PropertyKind.OTHER]. */
internal fun propertyKind(type: String): PropertyKind = KINDS[type] ?: PropertyKind.OTHER
