package cz.semprec.app.presentation

/** The switches of the overview. The alarm of a plan or a night is a switch of its draft ([SleepAction.SetDraftAlarm]). */
enum class SleepSwitch { ENABLED, SHOW_IN_CALENDAR, MUTE_SEMP, ALARM_SNOOZE, PREP_REMINDER }

/** The part of the snake on the sleep dial that a finger holds: one end of the night, or the whole of it. */
enum class SleepDialHandle { BED, WAKE, WHOLE }

enum class SleepMinutesChoice { REMINDER_LEAD, GOAL }

sealed interface SleepAction {
    data object Retry : SleepAction

    /** Goes to [screen]. The night view opens only for a sheet that was opened for a night. */
    data class Open(val screen: SleepScreen) : SleepAction

    /** Goes one view back; the root view stays, the native sheet closes itself. */
    data object Back : SleepAction

    data class SetSwitch(val target: SleepSwitch, val on: Boolean) : SleepAction

    /** Picks a reminder lead or a goal ([minutes]) on the picker that is open, and goes back to the overview. */
    data class PickMinutes(val choice: SleepMinutesChoice, val minutes: Int) : SleepAction

    /** Picks an alarm sound on the picker that is open, and goes back to the overview. */
    data class PickSound(val sound: SleepAlarmSound) : SleepAction

    /**
     * Opens the editor on the plan [planId], or on a new plan for `null`. The editor is [SleepState.editor] until it
     * is confirmed or discarded. An id no plan has fails as not found.
     */
    data class EditPlan(val planId: String?) : SleepAction

    /**
     * Moves [handle] of the open draft (the editor, else the night's) to [minutes] after midnight, which snaps to the
     * dial's step and wraps around midnight; the other end of the night follows when the length would leave its range.
     */
    data class MoveDial(val handle: SleepDialHandle, val minutes: Int) : SleepAction

    /** Switches a weekday (1 for Monday up to 7 for Sunday) of the plan in the editor; another number is refused. */
    data class ToggleDraftDay(val day: Int) : SleepAction

    /** Sets the alarm of the open draft. */
    data class SetDraftAlarm(val on: Boolean) : SleepAction

    /** Writes the editor's draft as the plan it edits, or as a new plan named [newPlanName], which the native side writes in its language. */
    data class ConfirmDraft(val newPlanName: String) : SleepAction

    /** Deletes the plan the editor edits, unless it is the last one. */
    data object DeleteDraftPlan : SleepAction

    /** Closes the editor without writing. */
    data object DiscardDraft : SleepAction

    /** Writes the night's draft as the exception of the night the sheet is open for. */
    data object CommitNight : SleepAction

    data object ResetNight : SleepAction
    data object DismissSaveFailure : SleepAction
}
