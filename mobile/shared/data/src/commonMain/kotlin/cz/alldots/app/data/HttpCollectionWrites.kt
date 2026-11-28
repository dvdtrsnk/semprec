package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.CollectionDatabase
import cz.alldots.app.domain.CollectionItem
import cz.alldots.app.domain.CollectionProperty
import cz.alldots.app.domain.CollectionReads
import cz.alldots.app.domain.CollectionWrites
import cz.alldots.app.domain.FieldValue
import cz.alldots.app.domain.PageContent
import cz.alldots.app.domain.PropertyKind
import cz.alldots.app.domain.PropertyOption
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** The writes of the generic item API over the signed-in person's [api]; [reads] holds the schema they decode by. */
class HttpCollectionWrites(private val api: AuthenticatedApi, private val reads: CollectionReads) : CollectionWrites {
    override suspend fun create(
        database: CollectionDatabase,
        title: String,
        relation: Pair<String, String>?,
    ): RepositoryResult<CollectionItem> {
        val titleKey = database.title?.key ?: return RepositoryResult.Failure(FailureKind.INVALID_DATA)
        val body = buildJsonObject {
            putJsonObject("properties") { put(titleKey, title) }
            if (relation != null) {
                put(
                    "relations",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("propertyKey", relation.first)
                                put("targetItemIds", buildJsonArray { add(JsonPrimitive(relation.second)) })
                            },
                        )
                    },
                )
            }
        }
        val path = "/api/databases/${database.id.encodeURLPathPart()}/items"
        return decodeItem(api.send(HttpMethod.Post, path, body = body.toString()))
    }

    override suspend fun update(
        database: CollectionDatabase,
        itemId: String,
        version: String,
        changes: Map<String, FieldValue?>,
    ): RepositoryResult<CollectionItem> {
        val body = buildJsonObject {
            put("ifVersion", version)
            put(
                "properties",
                JsonObject(
                    changes.mapValues { (key, value) ->
                        encodeValue(database.property(key)?.kind ?: PropertyKind.TEXT, value)
                    },
                ),
            )
        }
        return decodeItem(api.send(HttpMethod.Patch, itemPath(itemId), body = body.toString()))
    }

    override suspend fun setRelation(itemId: String, propertyKey: String, targetId: String?): RepositoryResult<Unit> {
        val body = buildJsonObject { put("targetItemId", targetId?.let(::JsonPrimitive) ?: JsonNull) }
        val path = "${itemPath(itemId)}/relations/${propertyKey.encodeURLPathPart()}"
        return api.send(HttpMethod.Put, path, body = body.toString()).ignoreBody()
    }

    override suspend fun link(itemId: String, propertyKey: String, targetId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Put, edgePath(itemId, propertyKey, targetId), body = "{}").ignoreBody()

    override suspend fun unlinkEdge(itemId: String, propertyKey: String, targetId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, edgePath(itemId, propertyKey, targetId)).ignoreBody()

    override suspend fun unlinkValue(itemId: String, propertyKey: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, valueLinkPath(itemId, propertyKey, "unlink"), body = "{}").ignoreBody()

    override suspend fun relinkValue(itemId: String, propertyKey: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, valueLinkPath(itemId, propertyKey, "relink"), body = "{}").ignoreBody()

    override suspend fun delete(itemId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, itemPath(itemId)).ignoreBody()

    override suspend fun addOption(property: CollectionProperty, label: String): RepositoryResult<PropertyOption> {
        val body = buildJsonObject { put("label", label) }
        return decodeOption(api.send(HttpMethod.Post, optionsPath(property), body = body.toString()))
    }

    override suspend fun updateOption(
        property: CollectionProperty,
        key: String,
        label: String?,
        color: String?,
    ): RepositoryResult<PropertyOption> {
        val body = buildJsonObject {
            if (label != null) put("label", label)
            if (color != null) put("color", color)
        }
        return decodeOption(api.send(HttpMethod.Patch, optionPath(property, key), body = body.toString()))
    }

    override suspend fun removeOption(property: CollectionProperty, key: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, optionPath(property, key)).ignoreBody()

    override suspend fun replacePage(itemId: String, markdown: String, etag: String): RepositoryResult<PageContent> {
        val response = api.send(
            HttpMethod.Put,
            "${itemPath(itemId)}/page.md",
            body = markdown,
            extraHeaders = listOf(HttpHeaders.IfMatch to "\"$etag\""),
        )
        return when (response) {
            is ApiResponse.Failure -> RepositoryResult.Failure(response.kind)
            is ApiResponse.Success -> response.etag?.trim('"')
                ?.let { RepositoryResult.Content(PageContent(markdown, it)) }
                ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
    }

    override suspend fun upload(
        filename: String,
        mimeType: String,
        bytes: ByteArray,
        attachTo: Pair<String, String>?,
    ): RepositoryResult<CollectionItem> {
        val headers = buildList {
            add(FILENAME_HEADER to filename)
            if (attachTo != null) {
                add(ATTACH_ITEM_HEADER to attachTo.second)
                add(ATTACH_RELATION_HEADER to attachTo.first)
            }
        }
        return decodeItem(api.upload("/api/files", RawBody(mimeType, bytes), headers))
    }

    private suspend fun decodeItem(response: ApiResponse): RepositoryResult<CollectionItem> {
        val schema = when (val loaded = reads.schema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        return when (val result = response.decode<CollectionItemDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> result.value.decodeIn(schema)
        }
    }

    private fun decodeOption(response: ApiResponse): RepositoryResult<PropertyOption> =
        when (val result = response.decode<OptionDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> RepositoryResult.Content(result.value.toDomain())
        }

    private fun optionsPath(property: CollectionProperty) = "/api/properties/${property.id.encodeURLPathPart()}/options"

    /** An option key may hold a space, non-ASCII or `/`, so it is one encoded path segment. */
    private fun optionPath(property: CollectionProperty, key: String) =
        "${optionsPath(property)}/${key.encodeURLPathPart()}"

    private fun itemPath(itemId: String) = "/api/items/${itemId.encodeURLPathPart()}"

    private fun edgePath(itemId: String, propertyKey: String, targetId: String) =
        "${itemPath(itemId)}/relations/${propertyKey.encodeURLPathPart()}/${targetId.encodeURLPathPart()}"

    private fun valueLinkPath(itemId: String, propertyKey: String, action: String) =
        "${itemPath(itemId)}/links/${propertyKey.encodeURLPathPart()}/$action"

    private companion object {
        const val FILENAME_HEADER = "X-Filename"
        const val ATTACH_ITEM_HEADER = "X-Attach-To-Item"
        const val ATTACH_RELATION_HEADER = "X-Attach-Relation"
    }
}
