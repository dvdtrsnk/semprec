package cz.alldots.app.presentation

import cz.alldots.app.domain.SleepNight
import cz.alldots.app.domain.SleepNightChange
import cz.alldots.app.domain.SleepSettingsChange
import cz.alldots.app.domain.applyTo

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

internal fun SleepSession.resetNight() {
    val day = nightDay ?: return
    if (screen == SleepScreen.NIGHT) {
        write(onDone = { _: SleepNight? -> nightDraft = null }) { useCases.night(day, SleepNightChange(reset = true)) }
    }
}

/** Goes to [target]; the night view opens only for a sheet that was opened for a night. */
internal fun SleepSession.open(target: SleepScreen) {
    if (overview == null) return
    val allowed = target != SleepScreen.NIGHT || nightDay != null
    if (!allowed || saving) return
    goTo(target)
}

internal fun SleepSession.back() {
    val previous = when (screen) {
        rootScreen -> null
        SleepScreen.MAIN -> SleepScreen.NIGHT
        SleepScreen.NIGHT, SleepScreen.REMIND, SleepScreen.SOUND, SleepScreen.GOAL -> SleepScreen.MAIN
    }
    if (previous != null) goTo(previous)
}
