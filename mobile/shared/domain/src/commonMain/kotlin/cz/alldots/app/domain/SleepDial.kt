package cz.alldots.app.domain

private const val DAY_MINUTES = ClockTime.DAY_MINUTES
private const val NOON_MINUTES = DAY_MINUTES / 2

/**
 * The two ends of a night as minutes after midnight (`0` until `1440`). [durationMinutes] is the length of the night
 * as [SleepRules.durationMinutes] counts it.
 */
data class SleepTimes(val bedMinutes: Int, val wakeMinutes: Int) {
    val durationMinutes: Int get() = SleepRules.durationMinutes(bedMinutes, wakeMinutes)
}

/** A schedule while it is edited: the days it is active on, the two ends of its night and its alarm. */
data class SleepScheduleDraft(val wakeDays: Set<Int>, val times: SleepTimes, val alarm: Boolean) {
    /** The draft with [day] switched: removed when it is in the draft, otherwise added; `null` for a day that is not a weekday. */
    fun withDayToggled(day: Int): SleepScheduleDraft? = when {
        day !in SleepRules.WEEK -> null
        day in wakeDays -> copy(wakeDays = wakeDays - day)
        else -> copy(wakeDays = (wakeDays + day).sorted().toSet())
    }

    /** Whether the night is of a length the settings allow. */
    val hasNightLength: Boolean get() = SleepDial.isNightLength(times.durationMinutes)

    /** Whether the draft can be written as a plan: it has a day and a night of an allowed length. */
    val isComplete: Boolean get() = wakeDays.isNotEmpty() && hasNightLength
}

/**
 * The rules of the sleep dial, the 24-hour clock on which a schedule or a night is set: midnight at the top, the
 * hours clockwise, the night as a snake from bedtime to wake time. Every time the dial moves lands on a
 * [STEP_MINUTES] step and wraps around midnight. The length of the night never leaves [SleepRules.SHORTEST_NIGHT_MINUTES]
 * to [SleepRules.LONGEST_NIGHT_MINUTES]: past either end one end of the night pushes the other along, so shortening
 * it into minus shifts the whole snake. A bedtime from noon on runs through midnight (the server counts it so), which
 * makes the shortest night of such a bedtime reach midnight.
 */
object SleepDial {
    /** The step of every time on the dial, in minutes. */
    const val STEP_MINUTES = 5

    /** [minutes] on the nearest step, wrapped into the day: `1437` is `1435`, `-2` is `0`, `1441` is `0`. */
    fun snap(minutes: Int): Int {
        val wrapped = DialClock.wrap(minutes)
        return DialClock.wrap((wrapped + STEP_MINUTES / 2) / STEP_MINUTES * STEP_MINUTES)
    }

    /** Moves the bedtime to [to]; the wake time stays unless the length leaves its range, then it is pushed. */
    fun moveBed(times: SleepTimes, to: Int): SleepTimes {
        val bed = snap(to)
        val current = DialClock.clockwise(times.bedMinutes, times.wakeMinutes)
        val length = current - DialClock.signedDistance(times.bedMinutes, bed)
        return withLength(bed, length)
    }

    /** Moves the wake time to [to]; the bedtime stays unless the length leaves its range, then it is pushed. */
    fun moveWake(times: SleepTimes, to: Int): SleepTimes {
        val wake = snap(to)
        val current = DialClock.clockwise(times.bedMinutes, times.wakeMinutes)
        val length = current + DialClock.signedDistance(times.wakeMinutes, wake)
        val shortest = shortestLength(times.bedMinutes)
        return when {
            length > SleepRules.LONGEST_NIGHT_MINUTES ->
                SleepTimes(DialClock.wrap(wake - SleepRules.LONGEST_NIGHT_MINUTES), wake)
            length >= shortest -> SleepTimes(times.bedMinutes, wake)
            else -> pushedBed(times, wake)
        }
    }

    /** Moves the whole night so that it starts at [bedTo]; its length stays unless that bedtime needs a longer one. */
    fun moveWhole(times: SleepTimes, bedTo: Int): SleepTimes =
        withLength(snap(bedTo), DialClock.clockwise(times.bedMinutes, times.wakeMinutes))

    /** [times] with a length the rules allow, the bedtime kept. */
    fun fit(times: SleepTimes): SleepTimes =
        withLength(DialClock.wrap(times.bedMinutes), DialClock.clockwise(times.bedMinutes, times.wakeMinutes))

    /** A night is as long as the settings allow: [SleepRules.SHORTEST_NIGHT_MINUTES] to [SleepRules.LONGEST_NIGHT_MINUTES]. */
    fun isNightLength(minutes: Int): Boolean =
        minutes in SleepRules.SHORTEST_NIGHT_MINUTES..SleepRules.LONGEST_NIGHT_MINUTES

    /** The bedtime pushed back so that a night ending at [wake] is as short as allowed, or the shortest night of the bedtime. */
    private fun pushedBed(times: SleepTimes, wake: Int): SleepTimes {
        val bed = DialClock.wrap(wake - SleepRules.SHORTEST_NIGHT_MINUTES)
        return if (shortestLength(bed) == SleepRules.SHORTEST_NIGHT_MINUTES) {
            SleepTimes(bed, wake)
        } else {
            withLength(times.bedMinutes, 0)
        }
    }

    /** The shortest night that starts at [bed]: one that starts from noon on has to reach midnight. */
    private fun shortestLength(bed: Int): Int =
        if (bed >= NOON_MINUTES) maxOf(SleepRules.SHORTEST_NIGHT_MINUTES, DAY_MINUTES - bed)
        else SleepRules.SHORTEST_NIGHT_MINUTES

    private fun withLength(bed: Int, length: Int): SleepTimes {
        val allowed = length.coerceIn(shortestLength(bed), SleepRules.LONGEST_NIGHT_MINUTES)
        return SleepTimes(bed, DialClock.wrap(bed + allowed))
    }
}
