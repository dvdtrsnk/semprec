package cz.semprec.app.core

/** Whether the person lets the app ring system alarms; [UNSUPPORTED] on a device that has no such alarms. */
enum class DeviceAlarmAuthorization { NOT_DETERMINED, DENIED, AUTHORIZED, UNSUPPORTED }

/** Why the device refused to ring an alarm; an unexpected failure is [DeviceAlarmScheduling.Failed] instead. */
enum class DeviceAlarmFailure { NOT_AUTHORIZED, LIMIT_REACHED, UNSUPPORTED }

/** Where an alarm the device holds is: waiting for its moment, or ringing now. */
enum class DeviceAlarmPhase { SCHEDULED, ALERTING }

/** An alarm the device holds for this app: [id] is the platform's own identifier. */
class HeldDeviceAlarm(val id: String, val phase: DeviceAlarmPhase)

/** The answer to a request to ring an alarm. */
sealed interface DeviceAlarmScheduling {
    /** The device rings the alarm and calls it [id]. */
    class Scheduled(val id: String) : DeviceAlarmScheduling

    /** The device refused for a reason the app can tell the person. */
    class Refused(val failure: DeviceAlarmFailure) : DeviceAlarmScheduling

    /** The device failed in a way the app cannot explain. */
    data object Failed : DeviceAlarmScheduling
}

/**
 * The alarms the device rings by itself, the one thing about them that is not decided in Kotlin. The native app
 * implements it with the platform's alarm framework; the interface has no suspending function and no flow, only
 * calls and a callback each, so that a Swift class can implement it and a test can script it. Every call comes on
 * the main thread and every callback is called once, on the main thread.
 */
interface DeviceAlarms {
    fun authorization(): DeviceAlarmAuthorization

    /**
     * Asks the person to allow alarms when never asked, and answers what the person decided; an answer that was
     * given before is answered again without asking.
     */
    fun requestAuthorization(callback: (DeviceAlarmAuthorization) -> Unit)

    /**
     * Rings a one-off alarm at [ringAtEpochSeconds]; the person is asked to allow alarms when never asked. With
     * [opensWakeGuard] the alert has a second button that opens the app, where a code stops the alarm.
     */
    fun schedule(ringAtEpochSeconds: Long, opensWakeGuard: Boolean, callback: (DeviceAlarmScheduling) -> Unit)

    /** Removes the alarm [id], or stops it when it rings; `false` when the device could not. A gone alarm counts as removed. */
    fun cancel(id: String): Boolean

    /** The alarms of this app the device holds, or `null` when it could not read them. */
    fun held(callback: (List<HeldDeviceAlarm>?) -> Unit)
}

/** The alarms of a device that has none (tests, previews, macOS): nothing is ever allowed. */
class UnavailableDeviceAlarms : DeviceAlarms {
    override fun authorization(): DeviceAlarmAuthorization = DeviceAlarmAuthorization.UNSUPPORTED

    override fun requestAuthorization(callback: (DeviceAlarmAuthorization) -> Unit) =
        callback(DeviceAlarmAuthorization.UNSUPPORTED)

    override fun schedule(
        ringAtEpochSeconds: Long,
        opensWakeGuard: Boolean,
        callback: (DeviceAlarmScheduling) -> Unit,
    ) =
        callback(DeviceAlarmScheduling.Refused(DeviceAlarmFailure.UNSUPPORTED))

    override fun cancel(id: String): Boolean = true

    override fun held(callback: (List<HeldDeviceAlarm>?) -> Unit) = callback(emptyList())
}

/**
 * Where the app remembers which alarm of the device belongs to which ring of the sleep plan, as key to platform
 * identifier, across restarts. The device's alarms cannot say it themselves.
 */
interface SleepAlarmLedger {
    fun load(): Map<String, String>
    fun save(entries: Map<String, String>)
}

/** A [SleepAlarmLedger] that forgets with the process; the default where no store is wired. */
class InMemorySleepAlarmLedger : SleepAlarmLedger {
    private var current: Map<String, String> = emptyMap()

    override fun load(): Map<String, String> = current

    override fun save(entries: Map<String, String>) {
        current = entries
    }
}
