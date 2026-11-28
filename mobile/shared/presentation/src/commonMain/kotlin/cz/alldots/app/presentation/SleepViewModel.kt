package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.EditSleepNight
import cz.alldots.app.domain.EditSleepPlans
import cz.alldots.app.domain.EditSleepSettings
import cz.alldots.app.domain.LoadSleep
import cz.alldots.app.domain.SleepSettingsChange

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

    private fun onDraftAction(action: SleepAction.Draft) {
        when (action) {
            is SleepAction.Draft.EditPlan -> session.editPlan(action.planId)
            is SleepAction.Draft.MoveDial -> session.moveDial(action.handle, action.minutes)
            is SleepAction.Draft.ToggleDraftDay -> session.toggleDraftDay(action.day)
            is SleepAction.Draft.SetDraftAlarm -> session.setDraftAlarm(action.on)
            is SleepAction.Draft.ConfirmDraft -> session.confirmDraft(action.newPlanName)
            SleepAction.Draft.DeleteDraftPlan -> session.deleteDraftPlan()
            SleepAction.Draft.DiscardDraft -> session.discardDraft()
            SleepAction.Draft.CommitNight -> session.commitNight()
        }
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
            is SleepAction.Draft -> onDraftAction(action)
            SleepAction.ResetNight -> session.resetNight()
            SleepAction.DismissSaveFailure -> session.dismissSaveFailure()
        }
    }
}

private fun SleepAction.PickMinutes.toChange(): SleepSettingsChange = when (choice) {
    SleepMinutesChoice.REMINDER_LEAD -> SleepSettingsChange(prepReminderMinutes = minutes)
    SleepMinutesChoice.GOAL -> SleepSettingsChange(goalMinutes = minutes)
}
