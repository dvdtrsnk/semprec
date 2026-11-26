package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmFailure
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.HeldDeviceAlarm
import cz.semprec.app.core.SleepAlarmLedger
import cz.semprec.app.domain.HeldSleepAlarms
import cz.semprec.app.domain.LoadSleepAlarmNights
import cz.semprec.app.domain.PlanSleepAlarms
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepAlarmNights
import cz.semprec.app.domain.SleepAlarmPlan
import cz.semprec.app.domain.SleepAlarmRequest
import cz.semprec.app.domain.SleepRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.coroutines.resume
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/** How far one run of [SleepAlarmSync] got. */
enum class SleepAlarmSyncResult {
    /** The device holds the alarms the sleep plan asks for. */
    SYNCED,

    /** The device has no alarms to ring; nothing was done. */
    UNSUPPORTED,

    /** The sleep plan could not be read, so the alarms the device holds stay. */
    READ_FAILED,

    /** The person has not allowed the app to ring alarms. */
    NOT_AUTHORIZED,

    /** The device holds as many alarms as it lets the app hold. */
    LIMIT_REACHED,

    /** The device could not list, remove or ring an alarm for a reason the app cannot explain. */
    DEVICE_FAILED,
}

/**
 * Keeps the system alarms of the device in step with the sleep plan, for the whole process rather than one window:
 * every night whose alarm is on rings on its wake day while the plan is on. Which alarms that means is decided by
 * `PlanSleepAlarms`; this class reads the plan, hands the decision to the device and keeps the ledger that tells
 * the device's alarms apart. One run at a time: a run asked for meanwhile waits and reads again. A failed read keeps
 * what the device holds, and cancellation is rethrown.
 */
class SleepAlarmSync internal constructor(
    private val load: LoadSleepAlarmNights,
    private val alarms: DeviceAlarms,
    private val ledger: SleepAlarmLedger,
    private val now: () -> Instant,
    private val zone: () -> TimeZone,
) {
    private val running = Mutex()

    /** Reads the sleep plan and brings the alarms of the device in step with it. */
    suspend fun sync(): SleepAlarmSyncResult = exclusively {
        when (val read = guarded { load(PlanSleepAlarms.today(now(), zone())) }) {
            is RepositoryResult.Content -> hold(read.value)
            is RepositoryResult.Failure, null -> SleepAlarmSyncResult.READ_FAILED
        }
    }

    /** Nobody is signed in: removes the alarms of the person who was, apart from one that rings now. */
    suspend fun signedOut(): SleepAlarmSyncResult = exclusively {
        hold(SleepAlarmNights(enabled = false, nights = emptyList()))
    }

    /** One run at a time, and none on a device that has no alarms. */
    private suspend fun exclusively(run: suspend () -> SleepAlarmSyncResult): SleepAlarmSyncResult =
        running.withLock {
            val authorization = onDevice { alarms.authorization() }
            if (authorization == DeviceAlarmAuthorization.UNSUPPORTED) SleepAlarmSyncResult.UNSUPPORTED else run()
        }

    private suspend fun hold(nights: SleepAlarmNights): SleepAlarmSyncResult = onDevice {
        val device = heldAlarms() ?: return@onDevice SleepAlarmSyncResult.DEVICE_FAILED
        apply(PlanSleepAlarms(nights, HeldSleepAlarms(ledger.load(), device), now(), zone()))
    }

    /**
     * Removes, then rings. Whatever got done is in the ledger when this ends, also when it is cancelled half way:
     * an alarm whose answer never arrived is one the ledger does not know, which the next run removes.
     */
    private suspend fun apply(plan: SleepAlarmPlan): SleepAlarmSyncResult {
        var result = SleepAlarmSyncResult.SYNCED
        val entries = plan.keep.toMutableMap()
        try {
            for (id in plan.cancel) {
                if (!alarms.cancel(id)) result = SleepAlarmSyncResult.DEVICE_FAILED
            }
            for (request in plan.schedule) {
                when (val scheduling = schedule(request)) {
                    is DeviceAlarmScheduling.Scheduled -> entries[request.key] = scheduling.id
                    is DeviceAlarmScheduling.Refused -> return scheduling.failure.toResult()
                    DeviceAlarmScheduling.Failed -> result = SleepAlarmSyncResult.DEVICE_FAILED
                }
            }
        } finally {
            ledger.save(entries)
        }
        return result
    }

    private suspend fun schedule(request: SleepAlarmRequest): DeviceAlarmScheduling =
        suspendCancellableCoroutine { answer ->
            alarms.schedule(request.ringAt.epochSeconds) { answer.resume(it) }
        }

    private suspend fun heldAlarms(): List<HeldDeviceAlarm>? =
        suspendCancellableCoroutine { answer -> alarms.held { answer.resume(it) } }

    /** Runs [call] on the main thread, which every call of the device and every answer of it is on. */
    private suspend fun <T> onDevice(call: suspend () -> T): T = withContext(Dispatchers.Main) { call() }

    private fun DeviceAlarmFailure.toResult(): SleepAlarmSyncResult = when (this) {
        DeviceAlarmFailure.NOT_AUTHORIZED -> SleepAlarmSyncResult.NOT_AUTHORIZED
        DeviceAlarmFailure.LIMIT_REACHED -> SleepAlarmSyncResult.LIMIT_REACHED
        DeviceAlarmFailure.UNSUPPORTED -> SleepAlarmSyncResult.UNSUPPORTED
    }
}

/**
 * Creates [SleepAlarmSync], whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the repository port it takes stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class SleepAlarmSyncFactory(
    private val repository: SleepRepository,
    private val alarms: DeviceAlarms,
    private val ledger: SleepAlarmLedger,
) {
    fun sleepAlarmSync(): SleepAlarmSync = SleepAlarmSync(
        LoadSleepAlarmNights(repository),
        alarms,
        ledger,
        now = { Clock.System.now() },
        zone = { TimeZone.currentSystemDefault() },
    )
}
