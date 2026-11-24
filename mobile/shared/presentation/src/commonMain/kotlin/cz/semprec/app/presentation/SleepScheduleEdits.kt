package cz.semprec.app.presentation

import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.SleepSchedule

/** The actions that change plans; the others are not plan edits and do nothing here. */
internal fun SleepSession.editPlans(action: SleepAction) {
    when (action) {
        is SleepAction.ToggleDay -> toggleDay(action.day)
        is SleepAction.AddPlan -> addPlan(action.name)
        SleepAction.DeletePlan -> deletePlan()
        is SleepAction.SavePlan -> savePlan(action)
        is SleepAction.RemovePlan -> removePlan(action.planId)
        else -> Unit
    }
}

/** Writes the schedule of the editor and returns to the overview once it is written. */
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
