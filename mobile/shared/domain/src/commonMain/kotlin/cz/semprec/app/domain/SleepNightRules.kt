package cz.semprec.app.domain

/** How long a night of sleep may be when its times change, and whether it reaches the sleep goal. */
object SleepNightRules {
    /** The shortest night a change of its times leaves, in minutes. */
    const val MIN_NIGHT_MINUTES: Int = 60

    /** The longest night a change of its times leaves, in minutes. */
    const val MAX_NIGHT_MINUTES: Int = 16 * 60

    /** Whether a night from [bed] to [wake] is neither shorter nor longer than a night may be. */
    fun isNightLength(bed: ClockTime, wake: ClockTime): Boolean =
        SleepRules.durationMinutes(bed, wake) in MIN_NIGHT_MINUTES..MAX_NIGHT_MINUTES

    /** Whether a night of [duration] minutes reaches the sleep [goal]. */
    fun meetsGoal(duration: Int, goal: Int): Boolean = duration >= goal
}
