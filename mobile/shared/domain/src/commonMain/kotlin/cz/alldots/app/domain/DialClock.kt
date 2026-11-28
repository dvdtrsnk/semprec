package cz.alldots.app.domain

private const val DAY_MINUTES = ClockTime.DAY_MINUTES
private const val HALF_DAY_MINUTES = DAY_MINUTES / 2

/** Arithmetic on the 24-hour dial: minutes after midnight wrap around the day. */
internal object DialClock {
    /** [minutes] brought into the day, `0` until `1440`. */
    fun wrap(minutes: Int): Int = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES

    /** The minutes from [from] clockwise to [to], `0` until `1440`. */
    fun clockwise(from: Int, to: Int): Int = wrap(to - from)

    /** The shorter way round the dial from [from] to [to]: positive clockwise. */
    fun signedDistance(from: Int, to: Int): Int {
        val forward = clockwise(from, to)
        return if (forward > HALF_DAY_MINUTES) forward - DAY_MINUTES else forward
    }
}
