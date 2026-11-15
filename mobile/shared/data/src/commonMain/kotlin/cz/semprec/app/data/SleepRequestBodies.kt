package cz.semprec.app.data

import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepPlanChange
import cz.semprec.app.domain.SleepSettingsChange
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal fun Set<Int>.toWire(): JsonElement =
    JsonArray(sorted().map { JsonPrimitive(WEEKDAYS[it - 1]) })

internal fun SleepSettingsChange.toProperties(): JsonObject = buildJsonObject {
    enabled?.let { put("enabled", it) }
    showInCalendar?.let { put("showInCalendar", it) }
    muteSemp?.let { put("muteSemp", it) }
    alarmSound?.let { sound -> put("alarmSound", SOUNDS.entries.first { it.value == sound }.key) }
    alarmSnooze?.let { put("alarmSnooze", it) }
    goalMinutes?.let { put("goalMinutes", it) }
    prepReminder?.let { put("prepReminder", it) }
    prepReminderMinutes?.let { put("prepReminderMinutes", it) }
}

internal fun SleepPlanChange.toProperties(): JsonObject = buildJsonObject {
    name?.let { put("name", it) }
    wakeDays?.let { put("wakeDays", it.toWire()) }
    bed?.let { put("bedTime", it.toString()) }
    wake?.let { put("wakeTime", it.toString()) }
    alarm?.let { put("alarm", it) }
}

/** The body of the night PUT: a field that is absent stays, a `null` field follows the plan again. */
internal fun SleepNightChange.toBody(): String = buildJsonObject {
    if (reset) {
        put("bedTime", JsonNull)
        put("wakeTime", JsonNull)
        put("alarm", JsonNull)
    } else {
        bed?.let { put("bedTime", it.toString()) }
        wake?.let { put("wakeTime", it.toString()) }
        alarm?.let { put("alarm", it) }
    }
}.toString()
