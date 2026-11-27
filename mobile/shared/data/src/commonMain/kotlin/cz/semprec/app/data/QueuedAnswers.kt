package cz.semprec.app.data

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

private const val CREATED_STATUS = 201
private const val OK_STATUS = 200
private const val NO_CONTENT_STATUS = 204

/**
 * The answers the device makes up for a write it queued, so the repository that sent it decodes it as it decodes the
 * server's (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection.md). An item it creates
 * carries the id made on the device; an item it changes is the kept one with the change in it.
 */
internal object QueuedAnswers {
    /** The ids whose kept objects [answer] reads for [request]: the item changed, the series, the related items. */
    fun lookups(route: QueuedRoute, request: ApiRequest): List<String> = when (route) {
        QueuedRoute.PATCH_ITEM -> listOfNotNull(segment(request.path, ITEM_SEGMENT))
        QueuedRoute.OCCURRENCE -> listOfNotNull(segment(request.path, SERIES_SEGMENT))
        QueuedRoute.CREATE_ITEM -> createRelations(body(request)).flatMap { (_, targets) -> targets }
        else -> emptyList()
    }

    /**
     * The answer to [request] queued under [route] at [queuedAt]: [newId] is the id made for what it creates and
     * [kept] the newest kept object of each id [lookups] named that the device holds.
     */
    fun answer(
        route: QueuedRoute,
        request: ApiRequest,
        newId: String?,
        queuedAt: String,
        kept: Map<String, JsonObject>,
    ): ApiResponse.Success = when (route) {
        QueuedRoute.CREATE_ITEM -> created(request, newId.orEmpty(), queuedAt, kept)
        QueuedRoute.PATCH_ITEM -> patched(request, queuedAt, kept)
        QueuedRoute.OCCURRENCE -> occurrence(request, newId.orEmpty(), queuedAt, kept)
        QueuedRoute.PERIOD_PAGE -> ApiResponse.Success(OK_STATUS, buildJsonObject { put("itemId", newId) }.toString())
        QueuedRoute.DELETE_ITEM,
        QueuedRoute.SET_RELATION,
        QueuedRoute.ADD_RELATION,
        QueuedRoute.REMOVE_RELATION,
        QueuedRoute.VALUE_LINK,
        -> ApiResponse.Success(NO_CONTENT_STATUS, "")
        QueuedRoute.SET_TASK_RECURRENCE,
        QueuedRoute.CLEAR_TASK_RECURRENCE,
        QueuedRoute.HOST_EVENT,
        QueuedRoute.INVITATION_ANSWER,
        -> ApiResponse.Success(OK_STATUS, "{}")
    }

    private fun created(
        request: ApiRequest,
        newId: String,
        queuedAt: String,
        kept: Map<String, JsonObject>,
    ): ApiResponse.Success {
        val body = body(request)
        val item = buildJsonObject {
            put("id", newId)
            put("databaseId", segment(request.path, DATABASE_SEGMENT).orEmpty())
            put("properties", body["properties"] as? JsonObject ?: JsonObject(emptyMap()))
            put(
                "relations",
                JsonObject(
                    createRelations(body).associate { (key, targets) ->
                        key to buildJsonArray {
                            targets.forEach { target ->
                                add(
                                    buildJsonObject {
                                        put("id", target)
                                        put("title", kept[target]?.titleOf().orEmpty())
                                    },
                                )
                            }
                        }
                    },
                ),
            )
            put("version", queuedAt)
            put("createdAt", queuedAt)
        }
        return ApiResponse.Success(CREATED_STATUS, item.toString())
    }

    private fun patched(request: ApiRequest, queuedAt: String, kept: Map<String, JsonObject>): ApiResponse.Success {
        val id = segment(request.path, ITEM_SEGMENT).orEmpty()
        val change = body(request)["properties"] as? JsonObject ?: JsonObject(emptyMap())
        val before = kept[id]
        val properties = JsonObject((before?.get("properties") as? JsonObject).orEmpty() + change)
        val item = JsonObject(
            (before ?: JsonObject(mapOf("id" to JsonPrimitive(id), "databaseId" to JsonPrimitive("")))) +
                mapOf("properties" to properties, "version" to JsonPrimitive(queuedAt)),
        )
        return ApiResponse.Success(OK_STATUS, item.toString())
    }

    private fun occurrence(
        request: ApiRequest,
        newId: String,
        queuedAt: String,
        kept: Map<String, JsonObject>,
    ): ApiResponse.Success {
        val series = kept[segment(request.path, SERIES_SEGMENT).orEmpty()]
        val date = segment(request.path, OCCURRENCE_DATE_SEGMENT).orEmpty()
        val properties = (series?.get("properties") as? JsonObject).orEmpty() + ("date" to JsonPrimitive(date))
        val item = buildJsonObject {
            put("id", newId)
            put("databaseId", (series?.get("databaseId") as? JsonPrimitive)?.contentOrNull.orEmpty())
            put("properties", JsonObject(properties))
            put("version", queuedAt)
        }
        return ApiResponse.Success(CREATED_STATUS, item.toString())
    }

    /** The relations of a create's body (`[{propertyKey, targetItemIds}]`), by key. */
    private fun createRelations(body: JsonObject): List<Pair<String, List<String>>> =
        (body["relations"] as? JsonArray).orEmpty().mapNotNull { element ->
            val relation = element as? JsonObject ?: return@mapNotNull null
            val key = (relation["propertyKey"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: return@mapNotNull null
            val targets = (relation["targetItemIds"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.takeIf { target -> target.isString }?.content }
            key to targets
        }

    private fun body(request: ApiRequest): JsonObject = request.body?.let { text ->
        try {
            ApiJson.parseToJsonElement(text) as? JsonObject
        } catch (_: SerializationException) {
            null
        }
    } ?: JsonObject(emptyMap())

    private const val DATABASE_SEGMENT = 3
    private const val ITEM_SEGMENT = 3
    private const val SERIES_SEGMENT = 4
    private const val OCCURRENCE_DATE_SEGMENT = 6
}

/** The [index]-th segment of [path] (`/api/items/i1`: 1 is `api`, 3 is `i1`), or `null`. */
internal fun segment(path: String, index: Int): String? = path.substringBefore('?').split('/').getOrNull(index)

/** What a kept object is called: its `title`, else the `name` or `title` property. */
internal fun JsonObject.titleOf(): String? {
    fun text(element: JsonElement?) = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
    val properties = this["properties"] as? JsonObject
    return text(this["title"]) ?: text(properties?.get("name")) ?: text(properties?.get("title"))
}

/**
 * The first JSON object in [this] tree, depth first, whose `id` is [id] and that has `properties`: an item as the
 * answers of the offline set carry it. With [whole], only one that also names its `databaseId`, as the item answers
 * carry it and the target of a relation does not.
 */
internal fun JsonElement.itemWithId(id: String, whole: Boolean = false): JsonObject? = when (this) {
    is JsonObject -> {
        val named = (this["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content == id
        val item = named && this["properties"] is JsonObject && (!whole || this["databaseId"] is JsonPrimitive)
        if (item) this else values.firstNotNullOfOrNull { it.itemWithId(id, whole) }
    }
    is JsonArray -> firstNotNullOfOrNull { it.itemWithId(id, whole) }
    else -> null
}

private fun JsonObject?.orEmpty(): Map<String, JsonElement> = this ?: emptyMap()

private fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()
