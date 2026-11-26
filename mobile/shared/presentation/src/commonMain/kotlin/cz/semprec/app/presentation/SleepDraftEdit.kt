package cz.semprec.app.presentation

import cz.semprec.app.domain.SleepDial
import cz.semprec.app.domain.SleepDrafts
import cz.semprec.app.domain.SleepPlan
import cz.semprec.app.domain.SleepRules
import cz.semprec.app.domain.SleepScheduleDraft

/**
 * A schedule or a night being edited: [original] is what it was when the edit began (or when it was last written),
 * [current] what the dial and the switches made of it. [planId] is the plan being edited, `null` for a new plan and
 * for a night.
 */
internal data class SleepDraftEdit(
    val planId: String?,
    val isNight: Boolean,
    val original: SleepScheduleDraft,
    val current: SleepScheduleDraft,
) {
    val isNew: Boolean get() = !isNight && planId == null

    /** Whether the draft can be written: complete, and for an existing plan or a night different from its start. */
    val canSave: Boolean get() = (if (isNight) current.hasNightLength else current.isComplete) &&
        (isNew || current != original)

    fun withDraft(next: SleepScheduleDraft): SleepDraftEdit = copy(current = next)
}

/** What the draft shows, against the [plans] it is one of and the sleep [goal]. */
internal fun SleepDraftEdit.toState(plans: List<SleepPlan>, goal: Int): SleepDraft {
    val times = current.times
    val duration = times.durationMinutes
    return SleepDraft(
        planId = planId,
        isNew = isNew,
        wakeDays = current.wakeDays.sorted(),
        takenDays = if (isNight) emptyList() else SleepDrafts.daysOfOtherPlans(plans, planId).sorted(),
        bedMinutes = times.bedMinutes,
        wakeMinutes = times.wakeMinutes,
        durationMinutes = duration,
        goalDifferenceMinutes = SleepRules.goalDifference(duration, goal),
        meetsGoal = SleepRules.meetsGoal(duration, goal),
        alarm = current.alarm,
        canSave = canSave,
        canDelete = planId != null && !isNight && SleepRules.canDeletePlan(plans),
        stepMinutes = SleepDial.STEP_MINUTES,
    )
}
