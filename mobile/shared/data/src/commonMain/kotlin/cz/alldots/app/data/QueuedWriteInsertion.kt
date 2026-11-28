package cz.alldots.app.data

import cz.alldots.app.domain.CalendarDay
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val STATUS_NOT_DONE = "notDone"

/** The properties of a new item that its timeline or agenda entry shows as they are. */
private val ENTRY_COPIED = listOf("date", "endDate", "timeFrom", "timeTo", "place")

/** The entry a timeline or an agenda would show for the item [made] of [kind] (`event` or `task`). */
internal fun entryOf(made: JsonObject, kind: String): JsonObject {
    val properties = made.objectAt("properties") ?: JsonObject(emptyMap())
    val calendar = (made.objectAt("relations")?.get("calendar") as? JsonArray)?.firstOrNull()?.idOf()
    return buildJsonObject {
        put("kind", kind)
        put("id", made.text("id"))
        put("title", properties.text("name"))
        ENTRY_COPIED.forEach { key -> properties[key]?.let { put(key, it) } }
        properties["timeTo"]?.let { put("effectiveTo", it) }
        put("allDay", properties["timeFrom"] == null || properties["timeFrom"] is JsonNull)
        put("calendarId", calendar)
        put("status", properties.text("status") ?: STATUS_NOT_DONE.takeIf { kind == "task" })
        put("readOnly", false)
        put("version", made.text("version"))
    }
}

/** Whether [this] reads the first page of `POST /api/databases/[database]/query` (no cursor, no search, not the trash). */
internal fun ApiRequest.isFirstQueryPage(database: String?): Boolean {
    val queryPath = database?.let { "/api/databases/$it/query" }
    if (method != HttpMethod.Post || path.substringBefore('?') != queryPath) return false
    val body = parseJsonObject(body) ?: JsonObject(emptyMap())
    val inTrash = (body["inTrash"] as? JsonPrimitive)?.content == "true"
    return body["cursor"] == null && body["q"] == null && !inTrash
}

/** Whether [this] reads a timeline or an agenda whose range holds [day]; an agenda only on its first page. */
internal fun ApiRequest.holdsDay(day: String?, root: JsonObject): Boolean {
    val date = day?.let(CalendarDay::parse) ?: return false
    val from = query.firstOrNull { it.first == "from" }?.second?.let(CalendarDay::parse)
    val to = query.firstOrNull { it.first == "to" }?.second?.let(CalendarDay::parse)
    return when (path.substringBefore('?')) {
        "/api/calendar/timeline" -> from != null && to != null && date in from..to
        "/api/calendar/agenda" -> from != null && date >= from && query.none { it.first == "cursor" } &&
            root["nextCursor"].let { it == null || it is JsonNull }
        else -> false
    }
}

/** [this] page with [item] in `items`, placed by the first key of [sort] when the item has a value for it. */
internal fun JsonObject.withItem(item: JsonObject, sort: JsonElement?): JsonObject {
    val items = (this["items"] as? JsonArray)?.toList() ?: return this
    val order = ((sort as? JsonArray)?.firstOrNull() as? JsonObject)
    val property = order?.text("property")
    val descending = order?.text("direction") == "desc"
    val value = property?.let { item.objectAt("properties")?.get(it) as? JsonPrimitive }
    val index = if (value == null) {
        items.size
    } else {
        items.indexOfFirst { other ->
            val compared =
                compare(value, (other as? JsonObject)?.objectAt("properties")?.get(property) as? JsonPrimitive)
            if (descending) compared > 0 else compared < 0
        }.takeIf { it >= 0 } ?: items.size
    }
    return JsonObject(this + ("items" to JsonArray(items.toMutableList().apply { add(index, item) })))
}

/** [this] timeline or agenda with [entry] in `items`, after the entries of the same day and time or earlier. */
internal fun JsonObject.withEntry(entry: JsonObject): JsonObject {
    val items = (this["items"] as? JsonArray)?.toList() ?: return this
    val key = entry.text("date").orEmpty() + entry.text("timeFrom").orEmpty()
    val index = items.indexOfFirst { other ->
        val node = other as? JsonObject
        (node?.text("date").orEmpty() + node?.text("timeFrom").orEmpty()) > key
    }.takeIf { it >= 0 } ?: items.size
    return JsonObject(this + ("items" to JsonArray(items.toMutableList().apply { add(index, entry) })))
}

/** Compares two property values as numbers when both are, else as text; a missing other value sorts last. */
private fun compare(value: JsonPrimitive, other: JsonPrimitive?): Int {
    if (other == null || other is JsonNull) return -1
    val numbers = value.content.toDoubleOrNull()?.takeIf { !value.isString } to
        other.content.toDoubleOrNull()?.takeIf { !other.isString }
    val (first, second) = numbers
    return if (first != null && second != null) first.compareTo(second) else value.content.compareTo(other.content)
}

/** The targets a `PUT /api/items/:id/relations/:key` sets: `targetItemId` (or none for `null`), or `targetItemIds`. */
internal fun setTargets(body: JsonObject?): List<String> {
    val many = (body?.get("targetItemIds") as? JsonArray)?.mapNotNull {
        (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content
    }
    return many ?: listOfNotNull(body?.text("targetItemId"))
}

internal fun targetOf(id: String, context: ProjectionContext) = buildJsonObject {
    put("id", id)
    put("title", context.titles[id].orEmpty())
}
