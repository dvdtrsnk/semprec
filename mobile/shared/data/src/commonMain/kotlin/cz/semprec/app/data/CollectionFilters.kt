package cz.semprec.app.data

import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionQuery
import cz.semprec.app.domain.CollectionScope
import cz.semprec.app.domain.FacetSelection
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.SortSpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private const val TYPE = "type"
private const val PROPERTY = "property"
private const val VALUE = "value"
private const val NODES = "nodes"
private const val AREA_VALUE = "areaValue"

/** Builds the request bodies of the query and facets routes from a [CollectionQuery]. */
internal object CollectionFilters {
    /** The body of `POST /api/databases/:id/query`. */
    fun queryBody(database: CollectionDatabase, query: CollectionQuery): JsonObject = buildJsonObject {
        filterOf(database, query)?.let { put("filter", it) }
        if (query.sort.isNotEmpty()) put("sort", JsonArray(query.sort.map(::sortElement)))
        query.cursor?.let { put("cursor", it) }
        put("limit", query.limit)
        query.search?.takeIf { it.isNotBlank() }?.let { put("q", it) }
        putJsonObject("include") {
            put("links", true)
            put("derived", true)
            if (query.expand.isNotEmpty()) {
                putJsonObject("relations") { query.expand.forEach { key -> putJsonArray(key) {} } }
            }
        }
    }

    /** The body of `POST /api/databases/:id/facets`: each facet ignores its own selection on the server. */
    fun facetsBody(database: CollectionDatabase, query: CollectionQuery, propertyKeys: List<String>): JsonObject =
        buildJsonObject {
            filterOf(database, query)?.let { put("filter", it) }
            putJsonArray("facets") { propertyKeys.forEach { add(JsonPrimitive(it)) } }
        }

    /** The conditions that always apply, then the scope, the chip and the selections, joined with `and`. */
    private fun filterOf(database: CollectionDatabase, query: CollectionQuery): JsonElement? {
        val nodes = buildList {
            database.collectionFilter?.let { add(parse(it)) }
            scopeFilter(database, query.scope)?.let { add(it) }
            query.quickFilter?.let { add(parse(it)) }
            query.selections.forEach { selectionFilter(database, it)?.let(::add) }
        }
        return when (nodes.size) {
            0 -> null
            1 -> nodes.single()
            else -> buildJsonObject {
                put(TYPE, "and")
                put(NODES, JsonArray(nodes))
            }
        }
    }

    private fun scopeFilter(database: CollectionDatabase, scope: CollectionScope): JsonElement? = when (scope) {
        CollectionScope.Everything -> null
        is CollectionScope.Area -> database.areaFilter?.let { expandArea(parse(it), scope.areaId) }
        is CollectionScope.Related -> relationContains(scope.propertyKey, scope.itemId)
        is CollectionScope.Matching -> parse(scope.filter)
    }

    private fun selectionFilter(database: CollectionDatabase, selection: FacetSelection): JsonElement? =
        when (selection) {
            is FacetSelection.OneOf -> oneOf(database, selection)
            is FacetSelection.DatePreset -> buildJsonObject {
                put(TYPE, "date_relative")
                put(PROPERTY, selection.propertyKey)
                put("preset", selection.preset)
            }
            is FacetSelection.Checked -> buildJsonObject {
                put(TYPE, "equals")
                put(PROPERTY, selection.propertyKey)
                put(VALUE, selection.on)
            }
        }

    private fun oneOf(database: CollectionDatabase, selection: FacetSelection.OneOf): JsonElement? {
        val isRelation = database.property(selection.propertyKey)?.kind == PropertyKind.RELATION
        return when {
            selection.values.isEmpty() -> null
            isRelation -> {
                val conditions = selection.values.map { relationContains(selection.propertyKey, it) }
                conditions.singleOrNull() ?: buildJsonObject {
                    put(TYPE, "or")
                    put(NODES, JsonArray(conditions))
                }
            }
            else -> buildJsonObject {
                put(TYPE, "in")
                put(PROPERTY, selection.propertyKey)
                putJsonArray(VALUE) { selection.values.forEach { add(JsonPrimitive(it)) } }
            }
        }
    }

    fun relationContains(propertyKey: String, itemId: String): JsonObject = buildJsonObject {
        put(TYPE, "relation_contains")
        put(PROPERTY, propertyKey)
        put(VALUE, itemId)
    }

    private fun sortElement(spec: SortSpec): JsonObject = buildJsonObject {
        if (spec.propertyKey != null) put(PROPERTY, spec.propertyKey) else put("system", spec.systemKey.orEmpty())
        put("direction", if (spec.descending) "desc" else "asc")
    }

    private fun parse(tree: FilterTree): JsonElement = ApiJson.parseToJsonElement(tree.json)

    /** Replaces every `{ "areaValue": true }` of a declared area filter template with the area's id. */
    fun expandArea(template: JsonElement, areaId: String): JsonElement = when (template) {
        is JsonObject ->
            if (template.keys == setOf(AREA_VALUE)) JsonPrimitive(areaId)
            else JsonObject(template.mapValues { (_, child) -> expandArea(child, areaId) })
        is JsonArray -> buildJsonArray { template.forEach { add(expandArea(it, areaId)) } }
        else -> template
    }
}
