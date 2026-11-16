package cz.semprec.app.presentation

import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepSettingsChange
import cz.semprec.app.domain.applyTo

internal fun SleepSession.setSwitch(target: SleepSwitch, on: Boolean) {
    val change = when (target) {
        SleepSwitch.ENABLED -> SleepSettingsChange(enabled = on)
        SleepSwitch.SHOW_IN_CALENDAR -> SleepSettingsChange(showInCalendar = on)
        SleepSwitch.MUTE_SEMP -> SleepSettingsChange(muteSemp = on)
        SleepSwitch.ALARM_SNOOZE -> SleepSettingsChange(alarmSnooze = on)
        SleepSwitch.PREP_REMINDER -> SleepSettingsChange(prepReminder = on)
        SleepSwitch.ALARM -> null
    }
    val id = planId
    when {
        change != null -> changeSettings(change)
        screen == SleepScreen.PLAN && id != null -> write { useCases.plans.setAlarm(id, on) }
        screen == SleepScreen.NIGHT -> changeNight(SleepNightChange(alarm = on))
    }
}

/** Goes back to the overview and writes the picked value. */
internal fun SleepSession.pick(change: SleepSettingsChange) {
    if (saving) return
    screen = SleepScreen.MAIN
    changeSettings(change)
}

/** Shows the change at once and undoes it when the write fails. */
private fun SleepSession.changeSettings(change: SleepSettingsChange) {
    val current = overview ?: return
    if (saving) return
    overview = current.copy(settings = change.applyTo(current.settings))
    write(onFailed = { overview = current }) { useCases.settings(current.settings, change) }
}

internal fun SleepSession.setTime(field: SleepTimeField, minutes: Int) {
    val time = if (minutes in 0 until ClockTime.DAY_MINUTES) ClockTime(minutes) else return
    val bed = field == SleepTimeField.BED
    when (screen) {
        SleepScreen.NIGHT -> changeNight(if (bed) SleepNightChange(bed = time) else SleepNightChange(wake = time))
        SleepScreen.PLAN, SleepScreen.MAIN -> shownPlanId()?.let { id ->
            write { if (bed) useCases.plans.setBed(id, time) else useCases.plans.setWake(id, time) }
        }
        SleepScreen.REMIND, SleepScreen.SOUND, SleepScreen.GOAL -> Unit
    }
}

/** The plan whose times the ring edits: the open plan, else the plan of the shown night, else the first. */
private fun SleepSession.shownPlanId(): String? {
    val current = overview ?: return null
    val named = current.night?.planId
    return when {
        screen == SleepScreen.PLAN -> planId
        named != null && current.plans.any { it.id == named } -> named
        else -> current.plans.firstOrNull()?.id
    }
}

internal fun SleepSession.toggleDay(day: Int) {
    val current = overview ?: return
    val id = planId
    if (screen == SleepScreen.PLAN && id != null) write { useCases.plans.toggleDay(current.plans, id, day) }
}

internal fun SleepSession.addPlan(name: String) {
    val current = overview ?: return
    write(onDone = { id: String ->
        planId = id
        screen = SleepScreen.PLAN
    }) { useCases.plans.add(current.plans, name) }
}

internal fun SleepSession.deletePlan() {
    val current = overview ?: return
    val id = planId
    if (screen == SleepScreen.PLAN && id != null) {
        write(onDone = { _: Unit ->
            planId = null
            screen = SleepScreen.MAIN
        }) { useCases.plans.delete(current.plans, id) }
    }
}

internal fun SleepSession.resetNight() {
    if (screen == SleepScreen.NIGHT) changeNight(SleepNightChange(reset = true))
}

private fun SleepSession.changeNight(change: SleepNightChange) {
    val day = nightDay ?: return
    write { useCases.night(day, change) }
}
