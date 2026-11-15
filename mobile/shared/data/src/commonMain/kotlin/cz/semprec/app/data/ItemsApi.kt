package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The calls of the generic item API that every collection of the app shares: reading and writing items of a database
 * by its key, and their relations. Nothing here knows a particular collection; a repository decides which keys to
 * ask for and what the values mean. The ids of the system databases are looked up once and remembered.
 */
internal class ItemsApi(private val api: AuthenticatedApi) {
    private var databaseIds: Map<String, String>? = null

    /** Every database of the person, following the pages of `GET /api/databases`. */
    suspend fun databases(): RepositoryResult<List<DatabaseDto>> {
        val all = mutableListOf<DatabaseDto>()
        var cursor: String? = null
        do {
            val query = listOfNotNull("limit" to DATABASE_PAGE_SIZE, cursor?.let { "cursor" to it })
            val page = when (val answer = api.send(HttpMethod.Get, "/api/databases", query).decode<DatabasePageDto>()) {
                is RepositoryResult.Failure -> return answer
                is RepositoryResult.Content -> answer.value
            }
            all += page.databases
            cursor = page.nextCursor
        } while (cursor != null)
        databaseIds = all.mapNotNull { database -> database.key?.let { it to database.id } }.toMap()
        return RepositoryResult.Content(all)
    }

    /** The id of the system database with [key], looking the databases up once when it is not known yet. */
    suspend fun databaseId(key: String): RepositoryResult<String> {
        databaseIds?.get(key)?.let { return RepositoryResult.Content(it) }
        val failure = (databases() as? RepositoryResult.Failure)?.kind
        val id = databaseIds?.get(key)
        return when {
            failure != null -> RepositoryResult.Failure(failure)
            id != null -> RepositoryResult.Content(id)
            else -> RepositoryResult.Failure(FailureKind.NOT_FOUND)
        }
    }

    /** One page of `POST /api/databases/:id/query`. */
    suspend fun query(databaseId: String, request: ItemQuery): RepositoryResult<ItemPageDto> =
        api.send(HttpMethod.Post, "/api/databases/$databaseId/query", body = request.toJson()).decode()

    /** Every item the query matches, following the pages, up to [limit] items. */
    suspend fun queryAll(
        databaseId: String,
        request: ItemQuery,
        limit: Int = MAX_ITEMS
    ): RepositoryResult<List<ItemDto>> {
        val items = mutableListOf<ItemDto>()
        var cursor: String? = null
        do {
            val page = when (val answer = query(databaseId, request.copy(cursor = cursor, limit = PAGE_SIZE))) {
                is RepositoryResult.Failure -> return answer
                is RepositoryResult.Content -> answer.value
            }
            items += page.items
            cursor = page.nextCursor
        } while (cursor != null && items.size < limit)
        return RepositoryResult.Content(items.take(limit))
    }

    /** `GET /api/items/:id`, with the named relations expanded (each to the target properties listed). */
    suspend fun get(
        itemId: String,
        relations: Map<String, List<String>> = emptyMap(),
        links: Boolean = false,
    ): RepositoryResult<ItemDto> {
        val include = listOfNotNull("links".takeIf { links }, "relations".takeIf { relations.isNotEmpty() })
        val query = buildList {
            if (include.isNotEmpty()) add("include" to include.joinToString(","))
            relations.forEach { (key, projection) -> add("relations.$key" to projection.joinToString(",")) }
        }
        return api.send(HttpMethod.Get, "/api/items/$itemId", query).decode()
    }

    /** A request of an arbitrary authenticated path, for the few reads that are not item reads. */
    suspend fun send(
        method: HttpMethod,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: JsonElement? = null,
    ): ApiResponse = api.send(method, path, query, body?.toString())

    private companion object {
        const val DATABASE_PAGE_SIZE = "200"
        const val PAGE_SIZE = 200
        const val MAX_ITEMS = 1_000
    }
}

/**
 * What `POST /api/databases/:id/query` takes. [relations] expands relations of every item (each to the properties of
 * the target that are listed, a relation of the target among them), [links] adds the value links.
 */
internal data class ItemQuery(
    val filter: JsonObject? = null,
    val sort: List<Pair<String, String>> = emptyList(),
    val relations: Map<String, List<String>> = emptyMap(),
    val links: Boolean = false,
    val text: String? = null,
    val cursor: String? = null,
    val limit: Int? = null,
) {
    fun toJson(): String = buildJsonObject {
        if (filter != null) put("filter", filter)
        if (sort.isNotEmpty()) {
            put(
                "sort",
                JsonArray(
                    sort.map { (property, direction) ->
                        buildJsonObject {
                            put("property", property)
                            put("direction", direction)
                        }
                    },
                ),
            )
        }
        if (relations.isNotEmpty() || links) {
            put(
                "include",
                buildJsonObject {
                    if (links) put("links", true)
                    if (relations.isNotEmpty()) {
                        put(
                            "relations",
                            buildJsonObject {
                                relations.forEach { (key, projection) ->
                                    put(key, JsonArray(projection.map(::JsonPrimitive)))
                                }
                            },
                        )
                    }
                },
            )
        }
        if (text != null) put("q", text)
        if (cursor != null) put("cursor", cursor)
        if (limit != null) put("limit", limit)
    }.toString()
}

/** The node types of the backend's filter tree, as JSON objects; the tree is checked by the server. */
internal object Filter {
    fun and(vararg nodes: JsonObject): JsonObject = group("and", nodes.toList())

    fun or(vararg nodes: JsonObject): JsonObject = group("or", nodes.toList())

    fun equals(property: String, value: String): JsonObject = scalar("equals", property, JsonPrimitive(value))

    fun equals(property: String, value: Boolean): JsonObject = scalar("equals", property, JsonPrimitive(value))

    fun notEquals(property: String, value: String): JsonObject = scalar("not_equals", property, JsonPrimitive(value))

    fun isEmpty(property: String): JsonObject = condition("is_empty", property)

    fun isNotEmpty(property: String): JsonObject = condition("is_not_empty", property)

    /** `date_relative`: the date [property] lies in the named range around today (`today`, `past`, `beforeNow`). */
    fun dateRelative(property: String, preset: String): JsonObject = buildJsonObject {
        put("type", "date_relative")
        put("property", property)
        put("preset", preset)
    }
}

/** The relation conditions of the backend's filter tree. */
internal object RelationFilter {
    fun contains(property: String, itemId: String): JsonObject =
        scalar("relation_contains", property, JsonPrimitive(itemId))

    fun isEmpty(property: String): JsonObject = condition("relation_is_empty", property)

    /** `relation_path_contains`: a relation of the item, then a relation of the items it reaches, holds [itemId]. */
    fun pathContains(first: String, second: String, itemId: String): JsonObject = buildJsonObject {
        put("type", "relation_path_contains")
        put("path", JsonArray(listOf(JsonPrimitive(first), JsonPrimitive(second))))
        put("value", itemId)
    }
}

private fun group(type: String, nodes: List<JsonObject>): JsonObject = buildJsonObject {
    put("type", type)
    put("nodes", JsonArray(nodes))
}

private fun condition(type: String, property: String): JsonObject = buildJsonObject {
    put("type", type)
    put("property", property)
}

private fun scalar(type: String, property: String, value: JsonElement): JsonObject = buildJsonObject {
    put("type", type)
    put("property", property)
    put("value", value)
}

/** `null` as the JSON value of a cleared property. */
internal val ClearedValue: JsonElement = JsonNull
