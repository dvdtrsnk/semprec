package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class SleepPhase { LOADING, READY, ERROR }

/** The views of the sleep sheet: the overview, one night, and the three pickers of the overview. */
enum class SleepScreen { MAIN, NIGHT, REMIND, SOUND, GOAL }

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
 * A schedule or a night while it is edited on the dial: [planId] is the plan being edited, `null` for a new plan and
 * for a night; [wakeDays] are ISO weekdays and [takenDays] the weekdays other plans hold, which taking moves over.
 * Times are minutes after midnight; [durationMinutes] is the length of the night, [goalDifferenceMinutes] is positive
 * above the sleep goal and negative below it, [meetsGoal] says whether the goal is met. [canSave] says whether the
 * draft can be written, [canDelete] whether its plan can be deleted. [stepMinutes] is the step the dial moves in.
 */
data class SleepDraft(
    val planId: String?,
    val isNew: Boolean,
    val wakeDays: List<Int>,
    val takenDays: List<Int>,
    val bedMinutes: Int,
    val wakeMinutes: Int,
    val durationMinutes: Int,
    val goalDifferenceMinutes: Int,
    val meetsGoal: Boolean,
    val alarm: Boolean,
    val canSave: Boolean,
    val canDelete: Boolean,
    val stepMinutes: Int,
)

/**
 * The sleep sheet. [isRoot] is `true` on the view the sheet opens on, which closes the sheet instead of going back.
 * [editor] is the plan being edited or added, `null` while no editor is open; [nightDraft] is the night on the night
 * view. [saving] is `true` while a change is written; a plan or night that is confirmed meanwhile waits its turn.
 * [saveFailure] is the expected failure of the last write or of an action that was refused before any write (an
 * unknown plan, a number that is no weekday, a delete of a plan that is not saved yet), `null` for none or for an
 * unexpected failure together with [saveFailed]; after a failed write the draft is back in [editor].
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
    val night: SleepNightItem? = null,
    val editor: SleepDraft? = null,
    val nightDraft: SleepDraft? = null,
    val saving: Boolean = false,
    val saveFailed: Boolean = false,
    val saveFailure: FailureKind? = null,
)
