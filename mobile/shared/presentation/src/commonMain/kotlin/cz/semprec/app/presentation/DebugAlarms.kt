package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmFailure
import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.HeldDeviceAlarm
import cz.semprec.app.core.SleepAlarmLedger
import cz.semprec.app.core.WakeMission
import cz.semprec.app.domain.DebugAlarmRules
import cz.semprec.app.domain.DebugSchedule
import cz.semprec.app.domain.PlanSleepAlarms
import cz.semprec.app.domain.WakeCodes
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/** Why the debug alarm tool did not do what the person asked. */
enum class DebugAlarmFailure {
    /** The person has not allowed the app to ring alarms. */
    NOT_AUTHORIZED,

    /** The device holds as many alarms as it lets the app hold. */
    LIMIT_REACHED,

    /** The device has no alarms to ring. */
    UNSUPPORTED,

    /** The device could not list, ring or remove an alarm for a reason the app cannot explain. */
    DEVICE_FAILED,

    /** The device could not tell which alarms it holds, so the list is the one before. */
    READ_FAILED,

    /** A wake mission was asked for, but the wake settings hold no code that stops it. */
    NO_CODES,

    /** The moment asked for has passed, so nothing rings. */
    IN_THE_PAST,
}

/** What an alarm the app holds is: a plain one, or a wake mission with its watch alarms that a scanned code stops. */
enum class DebugAlarmKind { ALARM, MISSION }

/** Whose alarm it is: the sleep plan's, the debug tool's, or one the app does not know. */
enum class DebugAlarmSource { SLEEP_PLAN, DEBUG, UNKNOWN }

/**
 * One alarm or mission the app holds. [ringAtEpochSeconds] is `null` for an alarm that nothing tells the moment of;
 * [phase] is `null` for a mission whose own alarm the device no longer holds. A mission has [codeCount] codes and
 * [watchCount] watch alarms after its ring; an alarm has neither.
 */
data class DebugAlarmRow(
    val id: String,
    val kind: DebugAlarmKind,
    val source: DebugAlarmSource,
    val ringAtEpochSeconds: Long?,
    val phase: DeviceAlarmPhase?,
    val codeCount: Int = 0,
    val watchCount: Int = 0,
)

/**
 * The alarms of the debug tool, for the whole process rather than one window: they ring through the same
 * [DeviceAlarms], keep the plain ones in the same [ledger] and the wake missions in the same [wake] missions as the
 * sleep plan's, so a debug mission rings the guard like a real one. Their keys are not sleep keys, which tells
 * `PlanSleepAlarms` to leave them alone. One writer at a time: every change holds the lock of [wake], also while the
 * sleep alarm sync runs. A run that is cancelled half way leaves an alarm whose answer never arrived that nothing
 * knows, which the next sleep sync removes.
 */
class DebugAlarms internal constructor(
    private val alarms: DeviceAlarms,
    private val ledger: SleepAlarmLedger,
    private val wake: WakeMissions,
    private val now: () -> Instant,
    private val zone: () -> TimeZone,
) {
    private val watches = WakeWatchArming { ringAt -> alarms.ring(ringAt, opensWakeGuard = true) }

    /** Fires when the wake missions or the wake settings change, and once at the start. */
    internal val changes: Flow<Unit> = combine(wake.missions, wake.settings) { _, _ -> }

    /** The codes of the wake settings that a mission of the debug tool is stopped by; the switch is not asked. */
    internal fun codes(): List<String> = WakeCodes.normalize(wake.settings.value.codes)

    /** What the person decided about alarms, as the device knows it. Call it on the main thread. */
    internal fun authorization(): DeviceAlarmAuthorization = alarms.authorization()

    /** Asks the person to allow alarms when never asked, and answers what is decided. */
    internal suspend fun requestAuthorization(): DeviceAlarmAuthorization = onDevice { alarms.askForAuthorization() }

    /** The alarms and missions the app holds, soonest first, or `null` when the device could not list its alarms. */
    internal suspend fun rows(): List<DebugAlarmRow>? = wake.lock.withLock {
        onDevice {
            alarms.heldAlarms()?.let { rows(it, ledger.load(), wake.missions.value) }
        }
    }

    /**
     * Rings [schedule], as a wake mission of the stored codes when [withCodes], and arms the watch alarms of the
     * missions that are close. Answers why it did not, or `null` when everything the schedule asked for rings; a
     * refusal stops at the first alarm refused and keeps the ones before it.
     */
    internal suspend fun ring(schedule: DebugSchedule, withCodes: Boolean): DebugAlarmFailure? = wake.lock.withLock {
        onDevice {
            val codes = if (withCodes) codes() else emptyList()
            val rings = DebugAlarmRules.rings(schedule, now(), zone())
            when {
                withCodes && codes.isEmpty() -> DebugAlarmFailure.NO_CODES
                rings.isEmpty() -> DebugAlarmFailure.IN_THE_PAST
                else -> ringAll(rings, codes)
            }
        }
    }

    private suspend fun ringAll(rings: List<Instant>, codes: List<String>): DebugAlarmFailure? {
        val entries = ledger.load().toMutableMap()
        val missions = wake.missions.value.toMutableList()
        var failure: DebugAlarmFailure? = null
        try {
            for (ringAt in rings) {
                failure = ringOne(ringAt, codes, entries, missions)
                if (failure != null) break
            }
            if (failure == null && codes.isNotEmpty()) {
                failure = watches.arm(missions, now(), SleepAlarmSyncResult.SYNCED).toDebug()
            }
        } finally {
            ledger.save(entries)
            wake.replaceMissions(missions)
        }
        return failure
    }

    /** Rings one alarm at [ringAt] and records it, in [entries] when plain and in [missions] when it has [codes]. */
    private suspend fun ringOne(
        ringAt: Instant,
        codes: List<String>,
        entries: MutableMap<String, String>,
        missions: MutableList<WakeMission>,
    ): DebugAlarmFailure? = when (val scheduling = alarms.ring(ringAt.epochSeconds, codes.isNotEmpty())) {
        is DeviceAlarmScheduling.Scheduled -> {
            val key = DebugAlarmRules.key(ringAt, scheduling.id)
            if (codes.isEmpty()) {
                entries[key] = scheduling.id
            } else {
                missions += WakeMission(key, ringAt.epochSeconds, scheduling.id, codes)
            }
            null
        }
        is DeviceAlarmScheduling.Refused -> scheduling.failure.toDebug()
        DeviceAlarmScheduling.Failed -> DebugAlarmFailure.DEVICE_FAILED
    }

    /**
     * Removes the alarm [id], or the whole mission when [id] is its alarm or one of its watch alarms, and stops it
     * when it rings. Answers `null` when it is gone.
     */
    internal suspend fun cancel(id: String): DebugAlarmFailure? {
        val mission = wake.missions.value.firstOrNull { id == it.alarmId || id in it.watchIds }
        if (mission != null) return if (wake.finish(mission.key)) null else DebugAlarmFailure.DEVICE_FAILED
        return wake.lock.withLock {
            onDevice {
                val removed = alarms.cancel(id)
                ledger.save(ledger.load().filterValues { it != id })
                if (removed) null else DebugAlarmFailure.DEVICE_FAILED
            }
        }
    }

    /**
     * Removes every alarm and mission of the app, the sleep plan's too, which the next sleep alarm sync rings again,
     * and stops the one that rings. What the device could not remove is forgotten as well, and the next sleep alarm
     * sync removes it unless it rings.
     */
    internal suspend fun cancelAll(): DebugAlarmFailure? = wake.lock.withLock {
        onDevice {
            val held = alarms.heldAlarms() ?: return@onDevice DebugAlarmFailure.READ_FAILED
            val removed = held.map { alarms.cancel(it.id) }
            ledger.save(emptyMap())
            wake.replaceMissions(emptyList())
            if (removed.all { it }) null else DebugAlarmFailure.DEVICE_FAILED
        }
    }
}

/** What the person sees of the app's alarms: one row per plain alarm and per mission, the soonest first. */
private fun rows(
    device: List<HeldDeviceAlarm>,
    ledger: Map<String, String>,
    missions: List<WakeMission>,
): List<DebugAlarmRow> {
    val phases = device.associate { it.id to it.phase }
    val keys = ledger.entries.associate { (key, id) -> id to key }
    val watchIds = missions.flatMap { it.watchIds }.toSet()
    val missionAlarms = missions.map { it.alarmId }.toSet()
    val alarms = device.filter { it.id !in watchIds && it.id !in missionAlarms }.map {
        val key = keys[it.id]
        DebugAlarmRow(
            id = it.id,
            kind = DebugAlarmKind.ALARM,
            source = key?.let(::sourceOf) ?: DebugAlarmSource.UNKNOWN,
            ringAtEpochSeconds = key?.let(::ringAtOf)?.epochSeconds,
            phase = it.phase,
        )
    }
    val held = missions.map {
        DebugAlarmRow(
            id = it.alarmId,
            kind = DebugAlarmKind.MISSION,
            source = sourceOf(it.key),
            ringAtEpochSeconds = it.ringAtEpochSeconds,
            phase = phases[it.alarmId],
            codeCount = it.codes.size,
            watchCount = it.watchIds.count { id -> id in phases },
        )
    }
    val soonestFirst = compareBy<DebugAlarmRow>(
        { it.ringAtEpochSeconds == null },
        { it.ringAtEpochSeconds },
        { it.id },
    )
    return (alarms + held).sortedWith(soonestFirst)
}

private fun sourceOf(key: String): DebugAlarmSource = when {
    DebugAlarmRules.isDebugKey(key) -> DebugAlarmSource.DEBUG
    PlanSleepAlarms.isSleepKey(key) -> DebugAlarmSource.SLEEP_PLAN
    else -> DebugAlarmSource.UNKNOWN
}

private fun ringAtOf(key: String): Instant? = DebugAlarmRules.ringAt(key) ?: PlanSleepAlarms.ringAt(key)

private fun DeviceAlarmFailure.toDebug(): DebugAlarmFailure = when (this) {
    DeviceAlarmFailure.NOT_AUTHORIZED -> DebugAlarmFailure.NOT_AUTHORIZED
    DeviceAlarmFailure.LIMIT_REACHED -> DebugAlarmFailure.LIMIT_REACHED
    DeviceAlarmFailure.UNSUPPORTED -> DebugAlarmFailure.UNSUPPORTED
}

/** The arming of the watch alarms answers as the sleep alarm sync does; nothing but a failure is a failure. */
private fun SleepAlarmSyncResult.toDebug(): DebugAlarmFailure? = when (this) {
    SleepAlarmSyncResult.SYNCED -> null
    SleepAlarmSyncResult.UNSUPPORTED -> DebugAlarmFailure.UNSUPPORTED
    SleepAlarmSyncResult.NOT_AUTHORIZED -> DebugAlarmFailure.NOT_AUTHORIZED
    SleepAlarmSyncResult.LIMIT_REACHED -> DebugAlarmFailure.LIMIT_REACHED
    SleepAlarmSyncResult.READ_FAILED -> DebugAlarmFailure.READ_FAILED
    SleepAlarmSyncResult.DEVICE_FAILED -> DebugAlarmFailure.DEVICE_FAILED
}

/**
 * Creates [DebugAlarms], whose constructor is internal, for the SDK in the umbrella module. Hidden from Objective-C
 * and Swift, like the other factories, so that the ports it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class DebugAlarmsFactory(
    private val alarms: DeviceAlarms,
    private val ledger: SleepAlarmLedger,
    private val wake: WakeMissions,
) {
    fun debugAlarms(): DebugAlarms = DebugAlarms(
        alarms,
        ledger,
        wake,
        now = { Clock.System.now() },
        zone = { TimeZone.currentSystemDefault() },
    )
}
