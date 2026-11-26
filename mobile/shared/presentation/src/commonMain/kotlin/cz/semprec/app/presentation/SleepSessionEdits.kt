package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.SleepDial
import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepScheduleDraft
import cz.semprec.app.domain.SleepSettingsChange
import cz.semprec.app.domain.applyTo

internal fun SleepSession.setSwitch(target: SleepSwitch, on: Boolean) {
    val change = when (target) {
        SleepSwitch.ENABLED -> SleepSettingsChange(enabled = on)
        SleepSwitch.SHOW_IN_CALENDAR -> SleepSettingsChange(showInCalendar = on)
        SleepSwitch.MUTE_SEMP -> SleepSettingsChange(muteSemp = on)
        SleepSwitch.ALARM_SNOOZE -> SleepSettingsChange(alarmSnooze = on)
        SleepSwitch.PREP_REMINDER -> SleepSettingsChange(prepReminder = on)
    }
    changeSettings(change)
}

/** Goes back to the overview and writes the picked value. */
internal fun SleepSession.pick(change: SleepSettingsChange) {
    if (saving) return
    goTo(SleepScreen.MAIN)
    changeSettings(change)
}

/** Shows the change at once and undoes it when the write fails. */
private fun SleepSession.changeSettings(change: SleepSettingsChange) {
    val current = overview ?: return
    if (saving) return
    overview = current.copy(settings = change.applyTo(current.settings))
    write(onFailed = { overview = current }) { useCases.settings(current.settings, change) }
}

/** Opens the editor on a plan, or on a new one for `null`; an editor that is open stays as it is. */
internal fun SleepSession.editPlan(planId: String?) {
    val current = overview ?: return
    if (editor != null) return
    val draft = if (planId == null) {
        SleepDial.newPlanDraft(current.plans)
    } else {
        current.plans.firstOrNull { it.id == planId }?.let(SleepDial::draftOf)
    }
    if (draft == null) {
        fail(FailureKind.NOT_FOUND)
    } else {
        editor = SleepDraftEdit(planId = planId, isNight = false, original = draft, current = draft)
        publish()
    }
}

/** Moves one end of the open draft, or the whole night, on the dial; there is nothing to move without a draft. */
internal fun SleepSession.moveDial(handle: SleepDialHandle, minutes: Int) {
    changeDraft { draft ->
        val times = draft.times
        val moved = when (handle) {
            SleepDialHandle.BED -> SleepDial.moveBed(times, minutes)
            SleepDialHandle.WAKE -> SleepDial.moveWake(times, minutes)
            SleepDialHandle.WHOLE -> SleepDial.moveWhole(times, minutes)
        }
        draft.copy(times = moved)
    }
}

/** Switches a weekday of the editor's plan; a number that is no weekday is refused, a night has no days. */
internal fun SleepSession.toggleDraftDay(day: Int) {
    if (editor == null) return
    changeDraft { draft -> draft.withDayToggled(day) }
}

internal fun SleepSession.setDraftAlarm(on: Boolean) {
    changeDraft { draft -> draft.copy(alarm = on) }
}

/** Applies [change] to the editor's draft, else to the night's; `null` from [change] is a refusal. */
private fun SleepSession.changeDraft(change: (SleepScheduleDraft) -> SleepScheduleDraft?) {
    val open = editor ?: nightDraft ?: return
    val next = change(open.current)
    when {
        next == null -> fail(FailureKind.REJECTED)
        editor != null -> editor = open.withDraft(next)
        else -> nightDraft = open.withDraft(next)
    }
    if (next != null) publish()
}

/**
 * Writes the editor's draft in one write. The editor closes at once; a write that fails puts the draft back, so
 * nothing the person set is lost.
 */
internal fun SleepSession.confirmDraft(newPlanName: String) {
    val open = editor ?: return
    val plans = overview?.plans ?: return
    editor = null
    write(waits = true, onFailed = { editor = open }) {
        useCases.plans.save(plans, open.planId, newPlanName, open.current)
    }
}

/** Deletes the editor's plan; the editor closes at once and comes back with its draft when the delete fails. */
internal fun SleepSession.deleteDraftPlan() {
    val open = editor ?: return
    val plans = overview?.plans ?: return
    val id = open.planId
    if (id == null) {
        fail(FailureKind.REJECTED)
    } else {
        editor = null
        write(waits = true, onFailed = { editor = open }) { useCases.plans.delete(plans, id) }
    }
}

internal fun SleepSession.discardDraft() {
    if (editor != null) {
        editor = null
        publish()
    }
}

/** Writes the night's draft when it differs from the night; there is nothing to write otherwise. */
internal fun SleepSession.commitNight() {
    val day = nightDay ?: return
    val open = nightDraft ?: return
    if (!open.canSave) return
    write(
        waits = true,
        onDone = { _: SleepNight? -> nightDraft = nightDraft?.copy(original = open.current) },
    ) { useCases.night.commit(day, open.current.times, open.current.alarm) }
}

internal fun SleepSession.resetNight() {
    val day = nightDay ?: return
    if (screen == SleepScreen.NIGHT) {
        write(onDone = { _: SleepNight? -> nightDraft = null }) { useCases.night(day, SleepNightChange(reset = true)) }
    }
}
