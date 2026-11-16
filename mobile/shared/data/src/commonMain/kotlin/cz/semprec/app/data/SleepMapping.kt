package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.SleepPlan
import cz.semprec.app.domain.SleepSettings
import cz.semprec.app.domain.SleepSound
import kotlinx.serialization.json.JsonObject

internal val WEEKDAYS = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")
internal val SOUNDS = mapOf(
    "morning" to SleepSound.MORNING,
    "birds" to SleepSound.BIRDS,
    "piano" to SleepSound.PIANO,
    "vibrateOnly" to SleepSound.VIBRATE_ONLY,
)

internal fun RepositoryResult<List<SleepStoredItem>>.mapSettings(): RepositoryResult<SleepSettings> = when (this) {
    is RepositoryResult.Failure -> this
    is RepositoryResult.Content -> value.firstOrNull()?.toSettings()?.let { RepositoryResult.Content(it) }
        ?: RepositoryResult.Failure(FailureKind.NOT_FOUND)
}

internal fun RepositoryResult<List<SleepStoredItem>>.mapPlans(): RepositoryResult<List<SleepPlan>> = when (this) {
    is RepositoryResult.Failure -> this
    is RepositoryResult.Content -> {
        val plans = value.map { it.toPlan() }
        if (plans.any { it == null }) {
            RepositoryResult.Failure(FailureKind.INVALID_DATA)
        } else {
            RepositoryResult.Content(plans.filterNotNull())
        }
    }
}

internal inline fun <reified T> JsonObject.narrow(): T? = try {
    ApiJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), this)
} catch (_: kotlinx.serialization.SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

internal fun SleepStoredItem.toSettings(): SleepSettings? {
    val values = properties.narrow<SleepSettingsProperties>()
    val sound = values?.let { SOUNDS[it.alarmSound] }
    return if (values == null || sound == null) {
        null
    } else {
        SleepSettings(
            itemId = id,
            enabled = values.enabled,
            showInCalendar = values.showInCalendar,
            muteSemp = values.muteSemp,
            alarmSound = sound,
            alarmSnooze = values.alarmSnooze,
            goalMinutes = values.goalMinutes,
            prepReminder = values.prepReminder,
            prepReminderMinutes = values.prepReminderMinutes,
        )
    }
}

internal fun SleepStoredItem.toPlan(): SleepPlan? {
    val values = properties.narrow<SleepPlanProperties>() ?: return null
    val bed = ClockTime.parse(values.bedTime)
    val wake = ClockTime.parse(values.wakeTime)
    val days = values.wakeDays.map { WEEKDAYS.indexOf(it) + 1 }
    return if (bed == null || wake == null || days.any { it == 0 }) {
        null
    } else {
        SleepPlan(id, values.name, days.toSet(), bed, wake, values.alarm, values.position)
    }
}

/** A resolved night, `null` when the server resolved none, and invalid data when it cannot be read. */
internal fun SleepNightDto?.toResult(): RepositoryResult<SleepNight?> = when (val night = this?.toDomain()) {
    null -> if (this == null) RepositoryResult.Content(null) else RepositoryResult.Failure(FailureKind.INVALID_DATA)
    else -> RepositoryResult.Content(night)
}

internal fun SleepNightDto.toDomain(): SleepNight? {
    val day = CalendarDay.parse(night)
    val bed = ClockTime.parse(bedTime)
    val wake = ClockTime.parse(wakeTime)
    return if (day == null || bed == null || wake == null) {
        null
    } else {
        SleepNight(day, planId, planName, bed, wake, alarm, changed, durationMinutes)
    }
}
