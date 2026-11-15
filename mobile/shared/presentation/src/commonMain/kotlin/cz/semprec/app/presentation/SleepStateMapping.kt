package cz.semprec.app.presentation

import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.SleepOverview
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

private fun ringOf(plan: SleepPlan, goal: Int): SleepRing {
    val duration = SleepRules.durationMinutes(plan.bed, plan.wake)
    val difference = SleepRules.goalDifference(duration, goal)
    return SleepRing(plan.bed.minutes, plan.wake.minutes, duration, difference, plan.alarm)
}

private fun ringOf(night: SleepNight, goal: Int): SleepRing = SleepRing(
    night.bed.minutes,
    night.wake.minutes,
    night.durationMinutes,
    SleepRules.goalDifference(night.durationMinutes, goal),
    night.alarm,
)

private fun baseRing(goal: Int): SleepRing {
    val duration = SleepRules.durationMinutes(SleepRules.BASE_BED, SleepRules.BASE_WAKE)
    return SleepRing(
        SleepRules.BASE_BED.minutes,
        SleepRules.BASE_WAKE.minutes,
        duration,
        SleepRules.goalDifference(duration, goal),
        alarm = false,
    )
}

/** What the ring shows: the plan being edited, else the night, else the first plan; a bare night shows the base. */
internal fun SleepOverview.ring(screen: SleepScreen, planId: String?): SleepRing? {
    val goal = settings.goalMinutes
    val edited = if (screen == SleepScreen.PLAN) plans.firstOrNull { it.id == planId } else null
    val shownNight = night
    return when {
        edited != null -> ringOf(edited, goal)
        shownNight != null -> ringOf(shownNight, goal)
        plans.isNotEmpty() -> ringOf(plans.first(), goal)
        screen == SleepScreen.NIGHT -> baseRing(goal)
        else -> null
    }
}
