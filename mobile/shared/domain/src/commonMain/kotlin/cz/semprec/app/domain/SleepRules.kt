package cz.semprec.app.domain

private const val NOON_MINUTES = 12 * 60
private const val FIRST_ISO_DAY = 1
private const val LAST_ISO_DAY = 7
private const val DEFAULT_NEW_BED_HOUR = 23
private const val DEFAULT_NEW_WAKE_HOUR = 7
private const val MINUTES_IN_HOUR = 60

/**
 * The decisions about sleep that are not a matter of one screen: which values the settings accept, how long a night
 * is, and which weekdays a new plan can still take (a weekday belongs to at most one plan, and the server moves a
 * day from the plan that held it to the plan that takes it).
 */
object SleepRules {
    /** What a night that follows no plan starts from when only an exception exists: the server's base night. */
    val BASE_BED: ClockTime = ClockTime(DEFAULT_NEW_BED_HOUR * MINUTES_IN_HOUR)
    val BASE_WAKE: ClockTime = ClockTime(DEFAULT_NEW_WAKE_HOUR * MINUTES_IN_HOUR)

    /** The sleep goals the settings accept, in minutes. */
    val GOALS: List<Int> = listOf(420, 450, 480, 510, 540)

    /** The lead times of the preparation reminder the settings accept, in minutes before bedtime. */
    val REMINDER_LEADS: List<Int> = listOf(15, 30, 45, 60)

    val WEEK: List<Int> = (FIRST_ISO_DAY..LAST_ISO_DAY).toList()

    /**
     * Bedtime to wake time as read on a clock, as the server counts it: a bedtime of noon or later runs through
     * midnight, an earlier one is on the morning of the wake day and never counts below zero.
     */
    fun durationMinutes(bed: ClockTime, wake: ClockTime): Int =
        if (bed.minutes >= EVENING_FROM_MINUTES) ClockTime.DAY_MINUTES - bed.minutes + wake.minutes
        else maxOf(0, wake.minutes - bed.minutes)

    /**
     * The first bedtime of a night that starts on the evening before the wake day, as the server counts it: a bedtime
     * of noon or later does, an earlier one is on the morning of the wake day.
     */
    const val EVENING_FROM_MINUTES: Int = NOON_MINUTES

    /** Positive when [duration] is longer than the [goal], negative when it is shorter. */
    fun goalDifference(duration: Int, goal: Int): Int = duration - goal

    /** The time the preparation reminder fires: [lead] minutes before [bed], around midnight if need be. */
    fun reminderTime(bed: ClockTime, lead: Int): ClockTime =
        ClockTime((bed.minutes - lead).mod(ClockTime.DAY_MINUTES))

    /** The weekdays no plan holds. */
    fun freeDays(plans: List<SleepPlan>): Set<Int> = WEEK.toSet() - plans.flatMap { it.wakeDays }.toSet()

    /** A plan can be added while some weekday has none. */
    fun canAddPlan(plans: List<SleepPlan>): Boolean = freeDays(plans).isNotEmpty()

    /** The last plan cannot be deleted: the sleep settings need a plan to follow. */
    fun canDeletePlan(plans: List<SleepPlan>): Boolean = plans.size > 1

    /** The wake days of [plan] after [day] is switched: removed when it was in the plan, otherwise added. */
    fun toggledDays(plan: SleepPlan, day: Int): Set<Int> =
        if (day in plan.wakeDays) plan.wakeDays - day else plan.wakeDays + day

    /** A plan for the days no plan holds, 23:00 to 7:00 with an alarm, after the last plan; `null` without a free day. */
    fun newPlan(plans: List<SleepPlan>, name: String): NewSleepPlan? {
        val days = freeDays(plans)
        return if (days.isEmpty()) {
            null
        } else {
            NewSleepPlan(
                name = name,
                wakeDays = days,
                bed = BASE_BED,
                wake = BASE_WAKE,
                alarm = true,
                position = (plans.maxOfOrNull { it.position } ?: -1) + 1,
            )
        }
    }

    /** Plans in the order the server resolves a night by: [SleepPlan.position], then the id. */
    fun ordered(plans: List<SleepPlan>): List<SleepPlan> = plans.sortedWith(compareBy({ it.position }, { it.id }))

    /** A sleep time is a start time: `24:00` is only an end of day and the server refuses it. */
    fun isSleepTime(time: ClockTime): Boolean = !time.isEndOfDay
}
