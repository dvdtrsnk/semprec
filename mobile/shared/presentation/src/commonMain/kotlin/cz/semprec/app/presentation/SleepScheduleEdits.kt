package cz.semprec.app.presentation

import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepSchedule

/**
 * The actions that change plans or the shown night as a whole. Every other action is listed as doing nothing here,
 * so a new action fails the build until it is placed.
 */
internal fun SleepSession.editSchedules(action: SleepAction) {
    when (action) {
        is SleepAction.ToggleDay -> toggleDay(action.day)
        is SleepAction.AddPlan -> addPlan(action.name)
        SleepAction.DeletePlan -> deletePlan()
        is SleepAction.SavePlan -> savePlan(action)
        is SleepAction.RemovePlan -> removePlan(action.planId)
        is SleepAction.SaveNight -> saveNight(action)
        SleepAction.Retry, is SleepAction.Open, SleepAction.Back, is SleepAction.SetSwitch,
        is SleepAction.PickMinutes, is SleepAction.PickSound, is SleepAction.SetTime, SleepAction.ResetNight,
        SleepAction.DismissSaveFailure -> Unit
    }
}

/**
 * Writes the schedule of the editor and returns to the overview once it is written. A time outside the day is
 * ignored without a failure, as [SleepSession.setTime] ignores one.
 */
internal fun SleepSession.savePlan(action: SleepAction.SavePlan) {
    val current = overview ?: return
    val inDay = 0 until ClockTime.DAY_MINUTES
    if (action.bedMinutes !in inDay || action.wakeMinutes !in inDay) return
    val schedule = SleepSchedule(
        wakeDays = action.wakeDays.toSet(),
        bed = ClockTime(action.bedMinutes),
        wake = ClockTime(action.wakeMinutes),
        alarm = action.alarm,
    )
    write(onDone = { _: Unit -> returnToOverview() }) {
        useCases.plans.save(current.plans, action.planId, action.name, schedule)
    }
}

/** Deletes a plan from the editor and returns to the overview once it is deleted. */
internal fun SleepSession.removePlan(planId: String) {
    val current = overview ?: return
    write(onDone = { _: Unit -> returnToOverview() }) { useCases.plans.delete(current.plans, planId) }
}

private fun SleepSession.returnToOverview() {
    planId = null
    if (screen == SleepScreen.PLAN) screen = SleepScreen.MAIN
}

/** Writes the times and the alarm the night view's dial shows, as one change of the shown night. */
private fun SleepSession.saveNight(action: SleepAction.SaveNight) {
    val day = nightDay ?: return
    val inDay = 0 until ClockTime.DAY_MINUTES
    if (screen != SleepScreen.NIGHT || action.bedMinutes !in inDay || action.wakeMinutes !in inDay) return
    val change = SleepNightChange(
        bed = ClockTime(action.bedMinutes),
        wake = ClockTime(action.wakeMinutes),
        alarm = action.alarm,
    )
    write { useCases.night(day, change) }
}
