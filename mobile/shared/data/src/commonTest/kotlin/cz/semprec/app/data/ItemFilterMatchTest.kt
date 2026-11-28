package cz.semprec.app.data

import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.TaskScope
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val FILTER_TODAY = CalendarDay(2026, 11, 23)

private fun item(json: String): JsonObject = ApiJson.parseToJsonElement(json).jsonObject

private fun node(json: String): JsonElement = ApiJson.parseToJsonElement(json)

class ItemFilterMatchTest {
    private val task = item(
        """{"id":"t1","properties":{"name":"Water","status":"notDone","date":"2026-11-23","flagged":true,"points":3,
           "tags":["a"],"empty":"","effectiveDate":"2026-11-23"},
           "relations":{"project":[{"id":"p1","title":"Garden"}],"people":[]}}""",
    )

    private fun matches(filter: String, on: JsonObject = task, today: CalendarDay = FILTER_TODAY) =
        ItemFilterMatch.matches(node(filter), on, today)

    @Test fun `no filter matches every item`() {
        assertTrue(ItemFilterMatch.matches(null, task, FILTER_TODAY))
        assertTrue(ItemFilterMatch.matches(JsonNull, task, FILTER_TODAY))
    }

    @Test fun `a filter that is not an object matches nothing`() {
        assertFalse(matches("[]"))
    }

    @Test fun `equals compares text and booleans and numbers by kind`() {
        assertTrue(matches("""{"type":"equals","property":"status","value":"notDone"}"""))
        assertFalse(matches("""{"type":"equals","property":"status","value":"done"}"""))
        assertTrue(matches("""{"type":"equals","property":"flagged","value":true}"""))
        assertTrue(matches("""{"type":"equals","property":"points","value":3}"""))
        assertFalse(matches("""{"type":"equals","property":"points","value":"3"}"""))
        assertFalse(matches("""{"type":"equals","property":"missing","value":"x"}"""))
    }

    @Test fun `not equals is the opposite of equals with a missing value included`() {
        assertTrue(matches("""{"type":"not_equals","property":"status","value":"done"}"""))
        assertFalse(matches("""{"type":"not_equals","property":"status","value":"notDone"}"""))
        assertTrue(matches("""{"type":"not_equals","property":"missing","value":"x"}"""))
    }

    @Test fun `in looks for the value among those listed`() {
        assertTrue(matches("""{"type":"in","property":"status","value":["done","notDone"]}"""))
        assertFalse(matches("""{"type":"in","property":"status","value":["done"]}"""))
        assertFalse(matches("""{"type":"in","property":"status","value":"notDone"}"""))
    }

    @Test fun `empty is a missing or null value or an empty text or list`() {
        assertTrue(matches("""{"type":"is_empty","property":"missing"}"""))
        assertTrue(matches("""{"type":"is_empty","property":"empty"}"""))
        assertFalse(matches("""{"type":"is_empty","property":"tags"}"""))
        assertTrue(matches("""{"type":"is_not_empty","property":"name"}"""))
        assertFalse(matches("""{"type":"is_not_empty","property":"missing"}"""))
        assertTrue(matches("""{"type":"is_empty","property":"x"}""", item("""{"properties":{"x":null}}""")))
        assertTrue(matches("""{"type":"is_empty","property":"x"}""", item("""{"properties":{"x":[]}}""")))
        assertTrue(matches("""{"type":"is_empty","property":"x"}""", item("""{"properties":{"x":{}}}""")))
    }

    @Test fun `and needs every node and or any`() {
        val yes = """{"type":"equals","property":"status","value":"notDone"}"""
        val no = """{"type":"equals","property":"status","value":"done"}"""
        assertTrue(matches("""{"type":"and","nodes":[$yes,$yes]}"""))
        assertFalse(matches("""{"type":"and","nodes":[$yes,$no]}"""))
        assertTrue(matches("""{"type":"or","nodes":[$no,$yes]}"""))
        assertFalse(matches("""{"type":"or","nodes":[$no,$no]}"""))
        assertTrue(matches("""{"type":"and","nodes":[]}"""))
        assertFalse(matches("""{"type":"or","nodes":[]}"""))
    }

    @Test fun `the day presets compare with the device's day`() {
        fun on(day: String, preset: String): Boolean {
            val filter = """{"type":"date_relative","property":"date","preset":"$preset"}"""
            return matches(filter, item("""{"properties":{"date":"$day"}}"""))
        }
        assertTrue(on("2026-11-23", "today"))
        assertFalse(on("2026-11-24", "today"))
        assertTrue(on("2026-11-24", "tomorrow"))
        assertTrue(on("2026-11-22", "past"))
        assertFalse(on("2026-11-23", "past"))
        assertTrue(on("2026-11-22", "beforeNow"))
        assertTrue(on("2026-11-23", "onOrBeforeToday"))
        assertFalse(on("2026-11-24", "onOrBeforeToday"))
        assertTrue(on("2026-11-23", "upcoming"))
        assertFalse(on("2026-11-22", "upcoming"))
        assertTrue(on("2026-11-16", "last7"))
        assertFalse(on("2026-11-15", "last7"))
        assertTrue(on("2026-10-24", "last30"))
        assertTrue(on("2026-10-23", "olderThan30"))
        assertFalse(on("2026-10-24", "olderThan30"))
        assertTrue(on("2026-01-01", "thisYear"))
        assertFalse(on("2025-12-31", "thisYear"))
    }

    @Test fun `a time of day counts as its day`() {
        val hidden = item("""{"properties":{"hiddenUntil":"2026-11-22T18:00:00.000Z"}}""")
        assertTrue(matches("""{"type":"date_relative","property":"hiddenUntil","preset":"beforeNow"}""", hidden))
    }

    @Test fun `presets of a week or a month and ranges with an end and values that are no day match nothing`() {
        assertFalse(matches("""{"type":"date_relative","property":"date","preset":"thisWeek"}"""))
        assertFalse(matches("""{"type":"date_relative","property":"date","preset":"thisMonth"}"""))
        assertFalse(matches("""{"type":"date_relative","property":"date","preset":{"fromDays":0}}"""))
        assertFalse(matches("""{"type":"date_relative","property":"date","endProperty":"endDate","preset":"today"}"""))
        assertFalse(matches("""{"type":"date_relative","property":"name","preset":"today"}"""))
        assertFalse(matches("""{"type":"date_relative","property":"missing","preset":"today"}"""))
    }

    @Test fun `relation nodes read the targets of the relation`() {
        assertTrue(matches("""{"type":"relation_contains","property":"project","value":"p1"}"""))
        assertFalse(matches("""{"type":"relation_contains","property":"project","value":"p2"}"""))
        assertFalse(matches("""{"type":"relation_contains","property":"project","value":{"placeholder":true}}"""))
        assertTrue(matches("""{"type":"relation_not_contains","property":"project","value":"p2"}"""))
        assertFalse(matches("""{"type":"relation_not_contains","property":"project","value":"p1"}"""))
        assertTrue(matches("""{"type":"relation_is_empty","property":"people"}"""))
        assertTrue(matches("""{"type":"relation_is_empty","property":"missing"}"""))
        assertTrue(matches("""{"type":"relation_is_not_empty","property":"project"}"""))
        assertFalse(matches("""{"type":"relation_is_not_empty","property":"people"}"""))
    }

    @Test fun `a node it does not know and a node without a property match nothing`() {
        assertFalse(matches("""{"type":"contains","property":"name","value":"Wat"}"""))
        assertFalse(matches("""{"type":"relation_path_contains","path":["project","company"],"value":"c1"}"""))
        assertFalse(matches("""{"type":"equals","value":"notDone"}"""))
    }

    @Test fun `a task made for today matches the Today and All lists the app asks for`() {
        val made = item(
            """{"properties":{"name":"Water","status":"notDone","date":"2026-11-23","effectiveDate":"2026-11-23"},
               "relations":{}}""",
        )
        assertTrue(ItemFilterMatch.matches(TaskFilters.forScope(TaskScope.TODAY), made, FILTER_TODAY))
        assertTrue(ItemFilterMatch.matches(TaskFilters.forScope(TaskScope.ALL), made, FILTER_TODAY))
        assertTrue(ItemFilterMatch.matches(TaskFilters.forScope(TaskScope.PLANNED), made, FILTER_TODAY))
        val tomorrow = item("""{"properties":{"status":"notDone","effectiveDate":"2026-11-24"},"relations":{}}""")
        assertFalse(ItemFilterMatch.matches(TaskFilters.forScope(TaskScope.TODAY), tomorrow, FILTER_TODAY))
    }
}
