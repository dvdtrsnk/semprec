package cz.alldots.app.data

import cz.alldots.app.domain.CalendarDay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val DATE_LENGTH = 10
private const val LAST_WEEK_DAYS = 7
private const val LAST_MONTH_DAYS = 30
private const val OLDER_THAN_DAYS = 31

/**
 * Whether an item the device made up matches a filter tree of `POST /api/databases/:id/query`, so a list kept on the
 * device can show it before the server has it (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-
 * connection.md). It evaluates the nodes the app sends, as the server does: `and`, `or`, `equals`, `not_equals`,
 * `in`, `is_empty`, `is_not_empty`, `date_relative` with the presets of a day (`today`, `tomorrow`, `past`,
 * `beforeNow`, `onOrBeforeToday`, `upcoming`, `last7`, `last30`, `olderThan30`, `thisYear`), `relation_contains`,
 * `relation_not_contains`, `relation_is_empty` and `relation_is_not_empty`. Any other node, a preset of a week or a
 * month, a range with an end property and a value of another shape match nothing, so the item waits for the server
 * rather than showing where it does not belong.
 */
internal object ItemFilterMatch {
    /** Whether [item] (`properties`, `relations`) matches [filter]; no filter matches every item. [today] is a day. */
    fun matches(filter: JsonElement?, item: JsonObject, today: CalendarDay): Boolean {
        val node = filter as? JsonObject
        val properties = item["properties"] as? JsonObject ?: JsonObject(emptyMap())
        val relations = item["relations"] as? JsonObject ?: JsonObject(emptyMap())
        val property = node?.text("property")
        val type = node?.text("type")
        return when {
            filter == null || filter is JsonNull -> true
            node == null -> false
            type == "and" -> node.nodes().all { matches(it, item, today) }
            type == "or" -> node.nodes().any { matches(it, item, today) }
            property == null -> false
            else -> propertyCondition(type, node, properties[property], today)
                ?: relationCondition(type, node, targets(relations, property))
                ?: false
        }
    }

    private fun propertyCondition(type: String?, node: JsonObject, value: JsonElement?, today: CalendarDay): Boolean? =
        when (type) {
            "equals" -> equal(value, node["value"])
            "not_equals" -> !equal(value, node["value"])
            "in" -> ((node["value"] as? JsonArray) ?: emptyList()).any { equal(value, it) }
            "is_empty" -> isEmpty(value)
            "is_not_empty" -> !isEmpty(value)
            "date_relative" -> node["endProperty"] == null && inRange(value, node.text("preset"), today)
            else -> null
        }

    private fun relationCondition(type: String?, node: JsonObject, targets: List<String>): Boolean? = when (type) {
        "relation_contains" -> node.text("value")?.let { it in targets } ?: false
        "relation_not_contains" -> node.text("value")?.let { it !in targets } ?: false
        "relation_is_empty" -> targets.isEmpty()
        "relation_is_not_empty" -> targets.isNotEmpty()
        else -> null
    }

    private fun equal(value: JsonElement?, expected: JsonElement?): Boolean {
        val actual = value as? JsonPrimitive
        val wanted = expected as? JsonPrimitive
        return actual != null && wanted != null && actual !is JsonNull && wanted !is JsonNull &&
            actual.isString == wanted.isString && actual.content == wanted.content
    }

    private fun isEmpty(value: JsonElement?): Boolean = when (value) {
        null, JsonNull -> true
        is JsonPrimitive -> value.isString && value.content.isEmpty()
        is JsonArray -> value.isEmpty()
        is JsonObject -> value.isEmpty()
    }

    private fun inRange(value: JsonElement?, preset: String?, today: CalendarDay): Boolean {
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
        val day = text?.let { CalendarDay.parse(it.take(DATE_LENGTH)) }
        val range = rangeOf(preset, today)
        return day != null && range != null &&
            (range.first?.let { day >= it } ?: true) && (range.second?.let { day <= it } ?: true)
    }

    /** The inclusive days of [preset] around [today]; `null` for a preset this evaluator does not know. */
    private fun rangeOf(preset: String?, today: CalendarDay): Pair<CalendarDay?, CalendarDay?>? = when (preset) {
        "today" -> today to today
        "tomorrow" -> today.plusDays(1) to today.plusDays(1)
        "past", "beforeNow" -> null to today.plusDays(-1)
        "onOrBeforeToday" -> null to today
        "upcoming" -> today to null
        "last7" -> today.plusDays(-LAST_WEEK_DAYS) to today
        "last30" -> today.plusDays(-LAST_MONTH_DAYS) to today
        "olderThan30" -> null to today.plusDays(-OLDER_THAN_DAYS)
        "thisYear" -> CalendarDay(today.year, 1, 1) to CalendarDay(today.year, DECEMBER, LAST_DAY_OF_DECEMBER)
        else -> null
    }

    private fun targets(relations: JsonObject, key: String): List<String> =
        ((relations[key] as? JsonArray) ?: emptyList()).mapNotNull { target ->
            ((target as? JsonObject)?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content
        }

    private fun JsonObject.nodes(): List<JsonElement> = (this["nodes"] as? JsonArray) ?: emptyList()

    private const val DECEMBER = 12
    private const val LAST_DAY_OF_DECEMBER = 31
}
