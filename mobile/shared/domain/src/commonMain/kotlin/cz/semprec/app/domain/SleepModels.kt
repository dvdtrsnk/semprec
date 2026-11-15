package cz.semprec.app.domain

/** The alarm sounds the settings offer; the wire names are `morning`, `birds`, `piano` and `vibrateOnly`. */
enum class SleepSound { MORNING, BIRDS, PIANO, VIBRATE_ONLY }

/** The sleep settings item. Which values the goal and the reminder lead time may take is decided by [SleepRules]. */
data class SleepSettings(
    val itemId: String,
    val enabled: Boolean,
    val showInCalendar: Boolean,
    val muteSemp: Boolean,
    val alarmSound: SleepSound,
    val alarmSnooze: Boolean,
    val goalMinutes: Int,
    val prepReminder: Boolean,
    val prepReminderMinutes: Int,
)

/** One sleep plan. [wakeDays] are ISO weekday numbers, 1 for Monday up to 7 for Sunday, of the days you wake up. */
data class SleepPlan(
    val id: String,
    val name: String,
    val wakeDays: Set<Int>,
    val bed: ClockTime,
    val wake: ClockTime,
    val alarm: Boolean,
    val position: Int,
)

/** One planned night as the server resolves it: [night] is the date of the evening the night starts. */
data class SleepNight(
    val night: CalendarDay,
    val planId: String?,
    val planName: String?,
    val bed: ClockTime,
    val wake: ClockTime,
    val alarm: Boolean,
    val changed: Boolean,
    val durationMinutes: Int,
)

/** Everything the sleep sheets read: the settings, the plans in order and, when a night was asked for, that night. */
data class SleepOverview(val settings: SleepSettings, val plans: List<SleepPlan>, val night: SleepNight?)

/** A change of the settings: each field that is not `null` is written. */
data class SleepSettingsChange(
    val enabled: Boolean? = null,
    val showInCalendar: Boolean? = null,
    val muteSemp: Boolean? = null,
    val alarmSound: SleepSound? = null,
    val alarmSnooze: Boolean? = null,
    val goalMinutes: Int? = null,
    val prepReminder: Boolean? = null,
    val prepReminderMinutes: Int? = null,
)

/** The settings after this change: the fields it names are replaced. */
fun SleepSettingsChange.applyTo(settings: SleepSettings): SleepSettings = settings.copy(
    enabled = enabled ?: settings.enabled,
    showInCalendar = showInCalendar ?: settings.showInCalendar,
    muteSemp = muteSemp ?: settings.muteSemp,
    alarmSound = alarmSound ?: settings.alarmSound,
    alarmSnooze = alarmSnooze ?: settings.alarmSnooze,
    goalMinutes = goalMinutes ?: settings.goalMinutes,
    prepReminder = prepReminder ?: settings.prepReminder,
    prepReminderMinutes = prepReminderMinutes ?: settings.prepReminderMinutes,
)

/** A change of one plan: each field that is not `null` is written. */
data class SleepPlanChange(
    val name: String? = null,
    val wakeDays: Set<Int>? = null,
    val bed: ClockTime? = null,
    val wake: ClockTime? = null,
    val alarm: Boolean? = null,
)

/** A plan to create. */
data class NewSleepPlan(
    val name: String,
    val wakeDays: Set<Int>,
    val bed: ClockTime,
    val wake: ClockTime,
    val alarm: Boolean,
    val position: Int,
)

/**
 * A change of the exception of one night: each field that is not `null` is written, and [reset] sets every field
 * back to "follow the plan".
 */
data class SleepNightChange(
    val bed: ClockTime? = null,
    val wake: ClockTime? = null,
    val alarm: Boolean? = null,
    val reset: Boolean = false,
)
