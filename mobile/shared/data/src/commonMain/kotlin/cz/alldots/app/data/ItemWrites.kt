package cz.alldots.app.data

import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The writes of the generic item API that every collection of the app shares; see [ItemsApi] for the reads. */
internal class ItemWrites(private val api: AuthenticatedApi) {
    /** `POST /api/databases/:id/items`, optionally with relations set in the same call. */
    suspend fun create(
        databaseId: String,
        properties: JsonObject,
        relations: Map<String, List<String>> = emptyMap(),
    ): RepositoryResult<ItemDto> {
        val body = buildJsonObject {
            put("properties", properties)
            if (relations.isNotEmpty()) {
                put(
                    "relations",
                    JsonArray(
                        relations.map { (key, targets) ->
                            buildJsonObject {
                                put("propertyKey", key)
                                put("targetItemIds", JsonArray(targets.map(::JsonPrimitive)))
                            }
                        },
                    ),
                )
            }
        }
        return api.send(HttpMethod.Post, "/api/databases/$databaseId/items", body = body.toString()).decode()
    }

    /** `PATCH /api/items/:id` of [properties], refused with [FailureKind.REJECTED] when [ifVersion] is stale. */
    suspend fun patch(itemId: String, properties: JsonObject, ifVersion: String): RepositoryResult<ItemDto> {
        val body = buildJsonObject {
            put("properties", properties)
            put("ifVersion", ifVersion)
        }
        return api.send(HttpMethod.Patch, "/api/items/$itemId", body = body.toString()).decode()
    }

    /** `DELETE /api/items/:id`: the item goes to the trash, from where it can be restored. */
    suspend fun delete(itemId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, "/api/items/$itemId").ignoreBody()

    /** Sets the single-valued relation [key] of an item to [targetId], or clears it for `null`. */
    suspend fun setRelation(itemId: String, key: String, targetId: String?): RepositoryResult<Unit> {
        val body = buildJsonObject { put("targetItemId", targetId.toJson()) }
        return api.send(HttpMethod.Put, "/api/items/$itemId/relations/$key", body = body.toString()).ignoreBody()
    }

    /** Adds one edge to the relation [key]; an edge that exists already stays. */
    suspend fun addRelation(itemId: String, key: String, targetId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Put, "/api/items/$itemId/relations/$key/$targetId").ignoreBody()

    /** Removes one edge from the relation [key]. */
    suspend fun removeRelation(itemId: String, key: String, targetId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, "/api/items/$itemId/relations/$key/$targetId").ignoreBody()

    /** Stops [key] following its source (`unlink`) or makes it follow the source again (`relink`). */
    suspend fun changeValueLink(itemId: String, key: String, relink: Boolean): RepositoryResult<Unit> {
        val action = if (relink) "relink" else "unlink"
        return api.send(HttpMethod.Post, "/api/items/$itemId/links/$key/$action").ignoreBody()
    }
}
