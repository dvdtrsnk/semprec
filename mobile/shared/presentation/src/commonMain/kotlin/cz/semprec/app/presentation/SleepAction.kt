package cz.semprec.app.presentation

/** The switches of the sheet; [ALARM] belongs to the plan or the night that is open. */
enum class SleepSwitch { ENABLED, SHOW_IN_CALENDAR, MUTE_SEMP, ALARM_SNOOZE, PREP_REMINDER, ALARM }

enum class SleepTimeField { BED, WAKE }

enum class SleepMinutesChoice { REMINDER_LEAD, GOAL }

sealed interface SleepAction {
    data object Retry : SleepAction

    /** Goes to [screen]; [planId] names the plan for [SleepScreen.PLAN]. Other views ignore it. */
    data class Open(val screen: SleepScreen, val planId: String? = null) : SleepAction

    /** Goes one view back; the root view stays, the native sheet closes itself. */
    data object Back : SleepAction

    data class SetSwitch(val target: SleepSwitch, val on: Boolean) : SleepAction

    /** Picks a reminder lead or a goal ([minutes]) on the picker that is open, and goes back to the overview. */
    data class PickMinutes(val choice: SleepMinutesChoice, val minutes: Int) : SleepAction

    /** Picks an alarm sound on the picker that is open, and goes back to the overview. */
    data class PickSound(val sound: SleepAlarmSound) : SleepAction

    /** Sets a time of the plan or night that is open; on the overview it sets it on the plan of the shown night. */
    data class SetTime(val field: SleepTimeField, val minutes: Int) : SleepAction

    data class ToggleDay(val day: Int) : SleepAction

    /** Adds a plan for the free days under [name], which the native side writes in its language. */
    data class AddPlan(val name: String) : SleepAction
    data object DeletePlan : SleepAction

    /**
     * Writes one schedule as the schedule editor shows it, in one write: a new plan named [name] when [planId] is
     * null, else the plan [planId]. [wakeDays] are ISO weekdays; the days it takes leave the plans that held them.
     * Goes back to the overview.
     */
    data class SavePlan(
        val planId: String?,
        val name: String,
        val wakeDays: List<Int>,
        val bedMinutes: Int,
        val wakeMinutes: Int,
        val alarm: Boolean,
    ) : SleepAction

    /** Deletes the plan [planId] from the schedule editor, unless it is the last one. */
    data class RemovePlan(val planId: String) : SleepAction
    data object ResetNight : SleepAction
    data object DismissSaveFailure : SleepAction
}
