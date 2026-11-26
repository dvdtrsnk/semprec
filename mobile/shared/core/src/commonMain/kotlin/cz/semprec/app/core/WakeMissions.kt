package cz.semprec.app.core

/** How this device wakes the person for the sleep plan: whether only a scanned code stops an alarm, and the codes. */
data class WakeSettings(val requiresCode: Boolean = false, val codes: List<String> = emptyList())

/**
 * A sleep alarm that only one of [codes] stops. [alarmId] is the device's alarm that rings at [ringAtEpochSeconds];
 * [watchIds] are the follow-up alarms after it, which ring again if the person silences the first, and [armed] says
 * that the device was asked for all of them, and held as many as it allowed.
 */
data class WakeMission(
    val key: String,
    val ringAtEpochSeconds: Long,
    val alarmId: String,
    val codes: List<String>,
    val watchIds: List<String> = emptyList(),
    val armed: Boolean = false,
)

/**
 * Where the device keeps the wake settings and its missions across restarts. The settings belong to this device only,
 * like the alarms it rings. Every call comes on the main thread.
 */
interface WakeStorage {
    fun loadSettings(): WakeSettings
    fun saveSettings(settings: WakeSettings)
    fun loadMissions(): List<WakeMission>
    fun saveMissions(missions: List<WakeMission>)
}

/** A [WakeStorage] that forgets with the process; the default where no store is wired. */
class InMemoryWakeStorage : WakeStorage {
    private var settings = WakeSettings()
    private var missions: List<WakeMission> = emptyList()

    override fun loadSettings(): WakeSettings = settings

    override fun saveSettings(settings: WakeSettings) {
        this.settings = settings
    }

    override fun loadMissions(): List<WakeMission> = missions

    override fun saveMissions(missions: List<WakeMission>) {
        this.missions = missions
    }
}
