package cz.alldots.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** `GET /api/schema`, reduced to what finds the three sleep databases by their canonical key. */
@Serializable
internal data class SleepSchemaResponse(val databases: List<SleepSchemaDatabase>)

@Serializable
internal data class SleepSchemaDatabase(val databaseId: String, val key: String? = null)

/**
 * One stored item of the generic item API; [properties] are narrowed by the sleep property DTOs below, and [version]
 * is the token a patch sends as `ifVersion`.
 */
@Serializable
internal data class SleepStoredItem(
    val id: String,
    val properties: JsonObject = JsonObject(emptyMap()),
    val version: String,
)

@Serializable
internal data class SleepItemList(val items: List<SleepStoredItem>)

@Serializable
internal data class SleepSettingsProperties(
    val enabled: Boolean,
    val showInCalendar: Boolean,
    val muteSemp: Boolean,
    val alarmSound: String,
    val alarmSnooze: Boolean,
    val goalMinutes: Int,
    val prepReminder: Boolean,
    val prepReminderMinutes: Int,
)

/** The write rules require a name and both times; an absent `wakeDays` is no day, `alarm` is off, `position` 0. */
@Serializable
internal data class SleepPlanProperties(
    val name: String,
    val bedTime: String,
    val wakeTime: String,
    val wakeDays: List<String> = emptyList(),
    val alarm: Boolean = false,
    val position: Int = 0,
)

/** One resolved night of `GET /api/sleep/nights` and `PUT /api/sleep/nights/:night`. */
@Serializable
internal data class SleepNightDto(
    val night: String,
    val planId: String? = null,
    val planName: String? = null,
    val bedTime: String,
    val wakeTime: String,
    val alarm: Boolean,
    val changed: Boolean,
    val durationMinutes: Int,
)

@Serializable
internal data class SleepNightsResponse(val nights: List<SleepNightDto>)

@Serializable
internal data class SleepNightEnvelope(val night: SleepNightDto? = null)

@Serializable
internal data class SleepPatchRequest(val properties: JsonObject, val ifVersion: String)

@Serializable
internal data class SleepCreateRequest(val properties: JsonObject)
