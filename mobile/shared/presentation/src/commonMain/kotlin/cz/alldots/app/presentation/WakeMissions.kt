package cz.alldots.app.presentation

import cz.alldots.app.core.DeviceAlarms
import cz.alldots.app.core.WakeMission
import cz.alldots.app.core.WakeSettings
import cz.alldots.app.core.WakeStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The wake settings and the wake missions of this device, for the whole process rather than one window: the sleep
 * alarm sync schedules missions and every window's guard watches them, so they share one instance. What changes is
 * written to [storage] at once and only then. One writer at a time: [SleepAlarmSync] holds [lock] for a whole run, and
 * [finish] waits for it.
 */
class WakeMissions(private val storage: WakeStorage, private val alarms: DeviceAlarms) {
    private val mutableSettings = MutableStateFlow(storage.loadSettings())
    private val mutableMissions = MutableStateFlow(storage.loadMissions())

    /** One writer of the missions and of the device's alarms at a time. */
    internal val lock = Mutex()

    val settings: StateFlow<WakeSettings> = mutableSettings.asStateFlow()

    /** The missions that wait or ring, soonest first as they were scheduled. */
    val missions: StateFlow<List<WakeMission>> = mutableMissions.asStateFlow()

    /** Keeps [transform] of the settings; nothing is written when they do not change. */
    internal fun changeSettings(transform: (WakeSettings) -> WakeSettings) {
        val changed = transform(mutableSettings.value)
        if (changed == mutableSettings.value) return
        mutableSettings.value = changed
        storage.saveSettings(changed)
    }

    /** Keeps [missions] as the held ones; nothing is written when they did not change. */
    internal fun replaceMissions(missions: List<WakeMission>) {
        if (missions == mutableMissions.value) return
        mutableMissions.value = missions
        storage.saveMissions(missions)
    }

    /**
     * The mission [key] ended: it is forgotten and its alarm and watch alarms are removed or stopped. Answers `false`
     * when the device could not remove one of them; the mission is gone either way, and the next sync removes an alarm
     * it does not know unless it rings.
     */
    internal suspend fun finish(key: String): Boolean = lock.withLock { finishHeld(key) }

    /** [finish] for a caller that holds [lock] already. */
    internal suspend fun finishHeld(key: String): Boolean {
        val mission = mutableMissions.value.firstOrNull { it.key == key } ?: return true
        replaceMissions(mutableMissions.value - mission)
        return withContext(Dispatchers.Main) {
            (listOf(mission.alarmId) + mission.watchIds).map { alarms.cancel(it) }.all { it }
        }
    }
}
