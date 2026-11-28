package cz.alldots.app.domain

private const val NOON_MINUTES = 12 * 60
private const val FIRST_ISO_DAY = 1
private const val LAST_ISO_DAY = 7
private const val DEFAULT_NEW_BED_HOUR = 23
private const val DEFAULT_NEW_WAKE_HOUR = 7
private const val MINUTES_IN_HOUR = 60

/**
 * The decisions about sleep that are not a matter of one screen: which values the settings accept, how long a night
 * is, and which weekdays a plan can take (a weekday belongs to at most one plan, and the server moves a day from the
 * plan that held it to the plan that takes it). Moving the ends of a night is in [SleepDial].
 */
object SleepRules {
    /** What a night that follows no plan starts from when only an exception exists: the server's base night. */
    val BASE_BED: ClockTime = ClockTime(DEFAULT_NEW_BED_HOUR * MINUTES_IN_HOUR)
    val BASE_WAKE: ClockTime = ClockTime(DEFAULT_NEW_WAKE_HOUR * MINUTES_IN_HOUR)

    /** The sleep goals the settings accept, in minutes. */
    val GOALS: List<Int> = listOf(420, 450, 480, 510, 540)

    /** The lead times of the preparation reminder the settings accept, in minutes before bedtime. */
    val REMINDER_LEADS: List<Int> = listOf(15, 30, 45, 60)

    /** The shortest night a schedule or a night can be set to, in minutes. */
    const val SHORTEST_NIGHT_MINUTES: Int = MINUTES_IN_HOUR

    /**
     * The longest night a schedule or a night can be set to, in minutes. A bedtime before noon must not reach past
     * midnight, which the server reads as a night of no length, and a bedtime before noon plus twelve hours never does.
     */
    const val LONGEST_NIGHT_MINUTES: Int = NOON_MINUTES

    val WEEK: List<Int> = (FIRST_ISO_DAY..LAST_ISO_DAY).toList()

    /**
     * Bedtime to wake time as read on a clock, as the server counts it: a bedtime of noon or later runs through
     * midnight, an earlier one is on the morning of the wake day and never counts below zero. This is the one
     * definition of the length of a night.
     */
    fun durationMinutes(bed: ClockTime, wake: ClockTime): Int = durationMinutes(bed.minutes, wake.minutes)

    /** [durationMinutes] for times given as minutes after midnight. */
    fun durationMinutes(bedMinutes: Int, wakeMinutes: Int): Int =
        if (bedMinutes >= NOON_MINUTES) ClockTime.DAY_MINUTES - bedMinutes + wakeMinutes
        else maxOf(0, wakeMinutes - bedMinutes)

    /**
     * Whether a night with this bedtime starts on the evening before the wake day, as the server counts it: a bedtime
     * of noon or later does, an earlier one is on the morning of the wake day.
     */
    fun startsTheEveningBefore(bed: ClockTime): Boolean = bed.minutes >= NOON_MINUTES

    /** Whether a night of [duration] meets the sleep [goal]. */
    fun meetsGoal(duration: Int, goal: Int): Boolean = duration >= goal

    /** Positive when [duration] is longer than the [goal], negative when it is shorter. */
    fun goalDifference(duration: Int, goal: Int): Int = duration - goal

    /** The time the preparation reminder fires: [lead] minutes before [bed], around midnight if need be. */
    fun reminderTime(bed: ClockTime, lead: Int): ClockTime =
        ClockTime((bed.minutes - lead).mod(ClockTime.DAY_MINUTES))

    /** The weekdays no plan holds. */
    fun freeDays(plans: List<SleepPlan>): Set<Int> = WEEK.toSet() - plans.flatMap { it.wakeDays }.toSet()

    /** The last plan cannot be deleted: the sleep settings need a plan to follow. */
    fun canDeletePlan(plans: List<SleepPlan>): Boolean = plans.size > 1

    /** Plans in the order the server resolves a night by: [SleepPlan.position], then the id. */
    fun ordered(plans: List<SleepPlan>): List<SleepPlan> = plans.sortedWith(compareBy({ it.position }, { it.id }))

    /** A sleep time is a start time: `24:00` is only an end of day and the server refuses it. */
    fun isSleepTime(time: ClockTime): Boolean = !time.isEndOfDay
}
