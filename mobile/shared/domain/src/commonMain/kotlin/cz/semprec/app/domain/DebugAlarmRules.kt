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

    /** Once, at [at]. */
    data class Once(val at: Instant) : DebugSchedule

    /** Every day at the wall-clock time that [at] has in the zone of the device. */
    data class Daily(val at: Instant) : DebugSchedule
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
    fun ringAt(key: String): Instant? {
        if (!isDebugKey(key)) return null
        val seconds = key.removePrefix(KEY_PREFIX).substringBefore(':').toLongOrNull() ?: return null
        return Instant.fromEpochSeconds(seconds)
    }

    /**
     * The moments [schedule] rings at after [now], soonest first, read in [zone]: a delay and a one-off moment ring
     * once, or never when the moment has passed; a daily alarm rings on [DAILY_DAYS] days from today, each at the
     * wall-clock time, so a day whose clocks change still rings at that time, and today's ring is left out when it
     * has passed.
     */
    fun rings(schedule: DebugSchedule, now: Instant, zone: TimeZone): List<Instant> = when (schedule) {
        is DebugSchedule.In -> listOf(now + schedule.seconds.seconds)
        is DebugSchedule.Once -> listOf(schedule.at)
        is DebugSchedule.Daily -> daily(schedule.at, now, zone)
    }.filter { it > now }

    private fun daily(at: Instant, now: Instant, zone: TimeZone): List<Instant> {
        val time = at.toLocalDateTime(zone)
        val today = PlanSleepAlarms.today(now, zone)
        return (0 until DAILY_DAYS).map {
            val day = today.plusDays(it)
            LocalDateTime(day.year, day.month, day.day, time.hour, time.minute).toInstant(zone)
        }
    }
}
