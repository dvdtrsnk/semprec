package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class SleepPhase { LOADING, READY, ERROR }

/** The views of the sleep sheet: the overview, one plan, one night, and the three pickers of the overview. */
enum class SleepScreen { MAIN, PLAN, NIGHT, REMIND, SOUND, GOAL }

enum class SleepAlarmSound { MORNING, BIRDS, PIANO, VIBRATE_ONLY }

/** One plan. Times are minutes after midnight; [wakeDays] are ISO weekdays, 1 for Monday up to 7 for Sunday. */
data class SleepPlanItem(
    val id: String,
    val name: String,
    val wakeDays: List<Int>,
    val bedMinutes: Int,
    val wakeMinutes: Int,
    val durationMinutes: Int,
    val alarm: Boolean,
)

/**
 * One resolved night. [night] is the date of the evening, `YYYY-MM-DD`; [planName] is `null` for a night that
 * follows no plan; [reminderMinutes] is the time of the preparation reminder, or `null` when it is off.
 */
data class SleepNightItem(
    val night: String,
    val planName: String?,
    val bedMinutes: Int,
    val wakeMinutes: Int,
    val durationMinutes: Int,
    val alarm: Boolean,
    val changed: Boolean,
    val reminderMinutes: Int?,
)

/**
 * What the ring of the sheet draws: the edited plan, the night, or the plan for the night. [goalDifferenceMinutes]
 * is positive above the goal and negative below it.
 */
data class SleepRing(
    val bedMinutes: Int,
    val wakeMinutes: Int,
    val durationMinutes: Int,
    val goalDifferenceMinutes: Int,
    val alarm: Boolean,
)

/**
 * The sleep sheet. [isRoot] is `true` on the view the sheet opens on, which closes the sheet instead of going back.
 * [saving] is `true` while a change is written; further changes wait. [saveFailure] is the expected failure of the
 * last write, `null` for none or an unexpected one together with [saveFailed].
 */
data class SleepState(
    val phase: SleepPhase = SleepPhase.LOADING,
    val failure: FailureKind? = null,
    val screen: SleepScreen = SleepScreen.MAIN,
    val isRoot: Boolean = true,
    val enabled: Boolean = true,
    val showInCalendar: Boolean = true,
    val muteSemp: Boolean = true,
    val alarmSound: SleepAlarmSound = SleepAlarmSound.MORNING,
    val alarmSnooze: Boolean = true,
    val goalMinutes: Int = 0,
    val prepReminder: Boolean = true,
    val prepReminderMinutes: Int = 0,
    val goalOptions: List<Int> = emptyList(),
    val reminderLeadOptions: List<Int> = emptyList(),
    val plans: List<SleepPlanItem> = emptyList(),
    val selectedPlanId: String? = null,
    val night: SleepNightItem? = null,
    val ring: SleepRing? = null,
    val takenDaysByOtherPlans: List<Int> = emptyList(),
    val canAddPlan: Boolean = false,
    val canDeletePlan: Boolean = false,
    val saving: Boolean = false,
    val saveFailed: Boolean = false,
    val saveFailure: FailureKind? = null,
)
