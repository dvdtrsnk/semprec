package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.EditSleepNight
import cz.semprec.app.domain.EditSleepPlans
import cz.semprec.app.domain.EditSleepSettings
import cz.semprec.app.domain.LoadSleep
import cz.semprec.app.domain.SleepSettingsChange

/**
 * The sleep sheet: the plan overview, one night and the pickers of the overview. [nightDay] is the evening the sheet
 * was opened for; with [startOnNight] the sheet opens on that night, which then is its root view. A plan is edited on
 * a draft ([SleepState.editor]) and a night on its own ([SleepState.nightDraft]): the dial, the days and the alarm
 * change the draft only, and it is written when it is confirmed. A change is written, then the whole overview is read
 * again, because the server moves wake days between plans and resolves the nights. While a write runs, a settings
 * change is ignored and a draft that is confirmed waits its turn. The screen has no effects: the native sheet closes
 * itself.
 */
class SleepViewModel internal constructor(
    nightDay: CalendarDay?,
    startOnNight: Boolean,
    loadSleep: LoadSleep,
    editSettings: EditSleepSettings,
    editPlans: EditSleepPlans,
    editNight: EditSleepNight,
) : ScreenViewModel<SleepState, SleepAction, Nothing>(SleepState()) {
    private val session = SleepSession(
        scope = viewModelScope,
        nightDay = nightDay,
        startOnNight = startOnNight,
        useCases = SleepUseCases(loadSleep, editSettings, editPlans, editNight),
        publishState = { next -> update { next } },
    )

    init {
        session.load()
    }

    override fun onAction(action: SleepAction) {
        if (isClosed) return
        when (action) {
            SleepAction.Retry -> session.load()
            is SleepAction.Open -> session.open(action.screen)
            SleepAction.Back -> session.back()
            is SleepAction.SetSwitch -> session.setSwitch(action.target, action.on)
            is SleepAction.PickMinutes -> session.pick(action.toChange())
            is SleepAction.PickSound -> session.pick(SleepSettingsChange(alarmSound = action.sound.toDomain()))
            is SleepAction.EditPlan -> session.editPlan(action.planId)
            is SleepAction.MoveDial -> session.moveDial(action.handle, action.minutes)
            is SleepAction.ToggleDraftDay -> session.toggleDraftDay(action.day)
            is SleepAction.SetDraftAlarm -> session.setDraftAlarm(action.on)
            is SleepAction.ConfirmDraft -> session.confirmDraft(action.newPlanName)
            SleepAction.DeleteDraftPlan -> session.deleteDraftPlan()
            SleepAction.DiscardDraft -> session.discardDraft()
            SleepAction.CommitNight -> session.commitNight()
            SleepAction.ResetNight -> session.resetNight()
            SleepAction.DismissSaveFailure -> session.dismissSaveFailure()
        }
    }
}

private fun SleepAction.PickMinutes.toChange(): SleepSettingsChange = when (choice) {
    SleepMinutesChoice.REMINDER_LEAD -> SleepSettingsChange(prepReminderMinutes = minutes)
    SleepMinutesChoice.GOAL -> SleepSettingsChange(goalMinutes = minutes)
}
