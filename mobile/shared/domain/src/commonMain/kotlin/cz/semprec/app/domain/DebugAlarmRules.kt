package cz.semprec.app.domain

import kotlinx.datetime.Instant
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Duration.Companion.seconds

/** When the debug tool asks the device to ring: a delay from now, a moment, or a time of day every day. */
sealed interface DebugSchedule {
    /** [seconds] from now. */
    data class In(val seconds: Int) : DebugSchedule

    /** Once, at the moment [epochSeconds]. */
    data class Once(val epochSeconds: Long) : DebugSchedule

    /** Every day at the wall-clock time that the moment [epochSeconds] has in the zone of the device. */
    data class Daily(val epochSeconds: Long) : DebugSchedule
}

/** What the debug tool does about a request to ring. */
sealed interface DebugRingPlan {
    /** Ring at each of [rings], soonest first. */
    data class Ring(val rings: List<Instant>) : DebugRingPlan

    /** A wake mission was asked for, but no code stops it. */
    data object NoCodes : DebugRingPlan

    /** The moment asked for is no moment a clock can have. */
    data object InvalidTime : DebugRingPlan

    /** Every moment asked for has passed, so nothing rings. */
    data object InThePast : DebugRingPlan
}

/**
 * The rules of the debug alarm tool, which tries the device's alarms outside the sleep plan: when its alarms ring and
 * how their keys tell the ledger and the wake missions that they are not the plan's.
 */
object DebugAlarmRules {
    private const val KEY_PREFIX = "debug:"

    /**
     * How many days ahead a daily alarm rings: the horizon the sleep plan rings over, one alarm per day, because the
     * device is asked for one-off alarms only, like the sleep alarms of a person.
     */
    const val DAILY_DAYS: Int = LoadSleepAlarmNights.HORIZON_DAYS

    /** The key of the debug alarm [id] that rings at [ringAt]; a key of the sleep plan never looks like it. */
    fun key(ringAt: Instant, id: String): String = "$KEY_PREFIX${ringAt.epochSeconds}:$id"

    fun isDebugKey(key: String): Boolean = key.startsWith(KEY_PREFIX)

    /** The moment the debug alarm [key] rings at, or `null` when [key] is not a debug key. */
    fun ringAt(key: String): Instant? =
        if (isDebugKey(key)) {
            key.removePrefix(KEY_PREFIX).substringBefore(':').toLongOrNull()?.let(Instant::fromEpochSeconds)
        } else {
            null
        }

    /**
     * What to do about a request to ring [schedule], as a wake mission stopped by [codes] when [withCodes]: a mission
     * needs a code, a moment must be one a clock can have, and a request whose moments have all passed rings nothing.
     */
    fun plan(
        schedule: DebugSchedule,
        withCodes: Boolean,
        codes: List<String>,
        now: Instant,
        zone: TimeZone,
    ): DebugRingPlan {
        val rings = rings(schedule, now, zone)
        return when {
            withCodes && codes.isEmpty() -> DebugRingPlan.NoCodes
            schedule !is DebugSchedule.In && momentOf(schedule) == null -> DebugRingPlan.InvalidTime
            rings.isEmpty() -> DebugRingPlan.InThePast
            else -> DebugRingPlan.Ring(rings)
        }
    }

    /**
     * The moments [schedule] rings at after [now], soonest first, read in [zone]: a delay and a one-off moment ring
     * once, or never when the moment has passed; a daily alarm rings on [DAILY_DAYS] days from today, each at the
     * wall-clock time, so a day whose clocks change still rings at that time, and today's ring is left out when it
     * has passed.
     */
    fun rings(schedule: DebugSchedule, now: Instant, zone: TimeZone): List<Instant> = when (schedule) {
        is DebugSchedule.In -> listOf(now + schedule.seconds.seconds)
        is DebugSchedule.Once -> listOfNotNull(momentOf(schedule))
        is DebugSchedule.Daily -> momentOf(schedule)?.let { daily(it, now, zone) }.orEmpty()
    }.filter { it > now }

    /** The moment a schedule names, or `null` when it names none or its seconds are outside the range of a clock. */
    private fun momentOf(schedule: DebugSchedule): Instant? = when (schedule) {
        is DebugSchedule.In -> null
        is DebugSchedule.Once -> moment(schedule.epochSeconds)
        is DebugSchedule.Daily -> moment(schedule.epochSeconds)
    }

    private fun moment(epochSeconds: Long): Instant? =
        if (epochSeconds in Instant.DISTANT_PAST.epochSeconds..Instant.DISTANT_FUTURE.epochSeconds) {
            Instant.fromEpochSeconds(epochSeconds)
        } else {
            null
        }

    private fun daily(at: Instant, now: Instant, zone: TimeZone): List<Instant> {
        val time = at.toLocalDateTime(zone)
        val today = PlanSleepAlarms.today(now, zone)
        return (0 until DAILY_DAYS).map {
            val day = today.plusDays(it)
            LocalDateTime(day.year, day.month, day.day, time.hour, time.minute).toInstant(zone)
        }
    }
}
