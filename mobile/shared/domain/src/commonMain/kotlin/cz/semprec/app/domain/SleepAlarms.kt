package cz.semprec.app.domain

import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.HeldDeviceAlarm
import cz.semprec.app.core.WakeMission
import kotlinx.datetime.Instant
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime

/**
 * One ring of the sleep plan the device rings: [key] names it, [ringAt] is the moment. With [codes] it is a wake
 * mission that one of them stops, otherwise a plain alarm.
 */
data class SleepAlarmRequest(val key: String, val ringAt: Instant, val codes: List<String> = emptyList())

/** The nights the device may ring for: [enabled] is the sleep plan on, and [nights] is empty while it is off. */
data class SleepAlarmNights(val enabled: Boolean, val nights: List<SleepNight>)

/**
 * The alarms the device holds for the sleep plan: [ledger] says which key each plain alarm was scheduled for, as key
 * to platform identifier, [missions] are the wake missions with their watch alarms, and [device] is what the device
 * lists, with the phase of each.
 */
class HeldSleepAlarms(
    val ledger: Map<String, String>,
    val device: List<HeldDeviceAlarm>,
    val missions: List<WakeMission> = emptyList(),
)

/**
 * What the device does to match the sleep plan: [schedule] the rings it does not hold, soonest first, [cancel] the
 * platform identifiers of the alarms the plan no longer asks for, and [keep] and [keepMissions] the ledger entries
 * and missions that stay.
 */
data class SleepAlarmPlan(
    val schedule: List<SleepAlarmRequest>,
    val cancel: List<String>,
    val keep: Map<String, String>,
    val keepMissions: List<WakeMission> = emptyList(),
)

/**
 * The nights the device rings for: the resolved nights from the evening before [today], whose alarm rings this
 * morning, through the evening [HORIZON_DAYS] − 2 days after [today]. A night ends on the day after its evening, so
 * the rings fall on the wake days from [today] through [HORIZON_DAYS] − 1 days after it. While the sleep plan is
 * off the answer holds no night and the nights are not read.
 */
class LoadSleepAlarmNights(private val repository: SleepRepository) {
    suspend operator fun invoke(today: CalendarDay): RepositoryResult<SleepAlarmNights> =
        when (val overview = repository.overview(null)) {
            is RepositoryResult.Failure -> overview
            is RepositoryResult.Content ->
                if (overview.value.settings.enabled) nights(today) else RepositoryResult.Content(OFF)
        }

    private suspend fun nights(today: CalendarDay): RepositoryResult<SleepAlarmNights> =
        when (val read = repository.nights(today.plusDays(-1), today.plusDays(HORIZON_DAYS - 2))) {
            is RepositoryResult.Failure -> read
            is RepositoryResult.Content -> RepositoryResult.Content(SleepAlarmNights(true, read.value))
        }

    companion object {
        /** How many mornings ahead the device rings: the device reads again whenever the app opens or the plan changes. */
        const val HORIZON_DAYS: Int = 7

        private val OFF = SleepAlarmNights(enabled = false, nights = emptyList())
    }
}

/**
 * Decides which system alarms the device holds for the sleep plan. A ring is the wake time of a night whose alarm
 * is on, on the day after its evening, read in the time zone of the device, so a day whose clocks change still
 * rings at the wake time on the wall clock. A ring that has passed is dropped, a key rings once, and an alarm that is
 * ringing now is never cancelled. The alarms of the app that the ledger does not know are cancelled as well.
 *
 * With active wake [codes] every ring is a mission that one of the codes stops, otherwise a plain alarm; a mission
 * whose codes are not the active ones, in any order, is replaced, and one whose ring has come belongs to the guard,
 * which ends it, so it is kept whatever the plan says.
 */
object PlanSleepAlarms {
    private const val KEY_PREFIX = "sleep:"

    /** The day of [now] in [zone]. */
    fun today(now: Instant, zone: TimeZone): CalendarDay {
        val date = now.toLocalDateTime(zone)
        return CalendarDay(date.year, date.monthNumber, date.dayOfMonth)
    }

    operator fun invoke(
        nights: SleepAlarmNights,
        held: HeldSleepAlarms,
        now: Instant,
        zone: TimeZone,
        codes: List<String> = emptyList(),
    ): SleepAlarmPlan {
        val wanted = if (nights.enabled) rings(nights.nights, now, zone, codes) else emptyMap()
        val onDevice = held.device.associateBy { it.id }
        val keep = mutableMapOf<String, String>()
        val cancel = mutableListOf<String>()
        for ((key, id) in held.ledger) {
            val alarm = onDevice[id] ?: continue
            if (key in wanted && codes.isEmpty()) keep[key] = id else if (alarm.canBeCancelled()) cancel += id
        }
        val keepMissions = mutableListOf<WakeMission>()
        for (mission in held.missions) {
            if (stays(mission, wanted, onDevice, codes, now)) {
                keepMissions += mission
            } else {
                cancel += (listOf(mission.alarmId) + mission.watchIds).filter { onDevice[it]?.canBeCancelled() == true }
            }
        }
        val known = held.ledger.values.toSet() + held.missions.flatMap { listOf(it.alarmId) + it.watchIds }
        cancel += held.device.filter { it.id !in known && it.canBeCancelled() }.map { it.id }
        val kept = keep.keys + keepMissions.map { it.key }
        return SleepAlarmPlan(
            schedule = wanted.values.filter { it.key !in kept },
            cancel = cancel.distinct(),
            keep = keep,
            keepMissions = keepMissions,
        )
    }

    /** A mission whose ring has come is the guard's; one that waits stays while the plan still asks for it as is. */
    private fun stays(
        mission: WakeMission,
        wanted: Map<String, SleepAlarmRequest>,
        onDevice: Map<String, HeldDeviceAlarm>,
        codes: List<String>,
        now: Instant,
    ): Boolean =
        WakeMissionRules.ringAt(mission) <= now ||
            (
                mission.key in wanted && codes.isNotEmpty() &&
                    WakeCodes.sameCodes(mission.codes, codes) && mission.alarmId in onDevice
                )

    private fun HeldDeviceAlarm.canBeCancelled(): Boolean = phase != DeviceAlarmPhase.ALERTING

    private fun rings(
        nights: List<SleepNight>,
        now: Instant,
        zone: TimeZone,
        codes: List<String>,
    ): Map<String, SleepAlarmRequest> =
        nights
            .filter { it.alarm && SleepRules.isSleepTime(it.wake) }
            .map { request(it, zone, codes) }
            .filter { it.ringAt > now }
            .sortedBy { it.ringAt }
            .associateBy { it.key }

    private fun request(night: SleepNight, zone: TimeZone, codes: List<String>): SleepAlarmRequest {
        val day = night.night.plusDays(1)
        val local = LocalDateTime(day.year, day.month, day.day, night.wake.hour, night.wake.minute)
        val ringAt = local.toInstant(zone)
        return SleepAlarmRequest("$KEY_PREFIX$ringAt", ringAt, codes)
    }
}
