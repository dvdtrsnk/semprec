package cz.semprec.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * One item of the generic item API (`GET /api/items/:id`, `POST /api/databases/:id/query`). [properties] is the
 * open-ended map of the item's own values; [relations] and [links] are present only when the request asked for them.
 * [version] is the item's optimistic-concurrency token, a decimal integer string the next write sends as `ifVersion`.
 */
@Serializable
internal data class ItemDto(
    val id: String,
    val databaseId: String,
    val properties: JsonObject = JsonObject(emptyMap()),
    val relations: Map<String, List<RelationTargetDto>> = emptyMap(),
    val links: Map<String, ValueLinkDto> = emptyMap(),
    val version: String = "",
)

/** The item at the other end of a relation. A [hidden] target is one the reader may not see: its id only. */
@Serializable
internal data class RelationTargetDto(
    val id: String,
    val title: String = "",
    val databaseKey: String? = null,
    val color: String? = null,
    val icon: String? = null,
    val hidden: Boolean = false,
    val properties: JsonObject? = null,
)

/** How a value of an item is tied to another item: inherited from it, inherited and since broken, or derived. */
@Serializable
internal data class ValueLinkDto(
    val valueKind: String,
    val sources: List<ValueLinkSourceDto> = emptyList(),
    val brokenBy: String? = null,
)

@Serializable
internal data class ValueLinkSourceDto(
    val kind: String,
    val itemId: String? = null,
    val databaseKey: String? = null,
    val title: String? = null,
    val propertyKey: String? = null,
)

@Serializable
internal data class ItemPageDto(val items: List<ItemDto> = emptyList(), val nextCursor: String? = null)

/** A database (a collection) as `GET /api/databases` lists it. */
@Serializable
internal data class DatabaseDto(
    val id: String,
    val name: String = "",
    val key: String? = null,
    val ownerModuleId: String? = null,
    val icon: String? = null,
    val color: String? = null,
    val overviewOrder: Int? = null,
    val clientVisible: Boolean = true,
    val overviewHidden: Boolean = false,
    val archivedAt: String? = null,
)

@Serializable
internal data class DatabasePageDto(val databases: List<DatabaseDto> = emptyList(), val nextCursor: String? = null)

/** The text of a string property, or `null` when it is missing, `null` or not a string. */
internal fun JsonObject.text(
    key: String
): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/** A boolean property, `false` when it is missing or not a boolean. */
internal fun JsonObject.flag(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false

/** A numeric property, or `null` when it is missing or not a number. */
internal fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

/** A JSON value for a nullable string. */
internal fun String?.toJson(): JsonElement = if (this == null) JsonNull else JsonPrimitive(this)
