package cz.semprec.app.presentation

import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.SleepPlan
import cz.semprec.app.domain.SleepRules
import cz.semprec.app.domain.SleepSettings
import cz.semprec.app.domain.SleepSound

internal fun SleepPlan.toItem(): SleepPlanItem = SleepPlanItem(
    id = id,
    name = name,
    wakeDays = wakeDays.sorted(),
    bedMinutes = bed.minutes,
    wakeMinutes = wake.minutes,
    durationMinutes = SleepRules.durationMinutes(bed, wake),
    alarm = alarm,
)

internal fun SleepNight.toItem(settings: SleepSettings): SleepNightItem = SleepNightItem(
    night = night.toString(),
    planName = planName,
    bedMinutes = bed.minutes,
    wakeMinutes = wake.minutes,
    durationMinutes = durationMinutes,
    alarm = alarm,
    changed = changed,
    reminderMinutes = if (settings.prepReminder) {
        SleepRules.reminderTime(bed, settings.prepReminderMinutes).minutes
    } else {
        null
    },
)

internal fun SleepSound.toPresentation(): SleepAlarmSound = when (this) {
    SleepSound.MORNING -> SleepAlarmSound.MORNING
    SleepSound.BIRDS -> SleepAlarmSound.BIRDS
    SleepSound.PIANO -> SleepAlarmSound.PIANO
    SleepSound.VIBRATE_ONLY -> SleepAlarmSound.VIBRATE_ONLY
}

internal fun SleepAlarmSound.toDomain(): SleepSound = when (this) {
    SleepAlarmSound.MORNING -> SleepSound.MORNING
    SleepAlarmSound.BIRDS -> SleepSound.BIRDS
    SleepAlarmSound.PIANO -> SleepSound.PIANO
    SleepAlarmSound.VIBRATE_ONLY -> SleepSound.VIBRATE_ONLY
}
