package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.WakeMission
import cz.semprec.app.domain.WakeMissionRules
import kotlinx.datetime.Instant

/**
 * Schedules the watch alarms of the wake missions that are close, through [schedule], which rings one alarm at an
 * epoch second and answers what the device said.
 */
internal class WakeWatchArming(private val schedule: suspend (Long) -> DeviceAlarmScheduling) {

    /**
     * Arms every mission in [missions] that is close at [now] and misses watch alarms; a refusal ends the arming and
     * is the answer, an unexplained failure makes it [SleepAlarmSyncResult.DEVICE_FAILED] after the others were tried.
     */
    suspend fun arm(
        missions: MutableList<WakeMission>,
        now: Instant,
        before: SleepAlarmSyncResult,
    ): SleepAlarmSyncResult {
        var result = before
        for (index in missions.indices) {
            if (!WakeMissionRules.needsWatches(missions[index], now)) continue
            val stopped = armWatches(missions, index)
            if (stopped is DeviceAlarmScheduling.Refused) return stopped.failure.toResult()
            if (stopped != null) result = SleepAlarmSyncResult.DEVICE_FAILED
        }
        return result
    }

    /**
     * Schedules the watch alarms of the mission at [index] that it does not hold yet, in order, so that a run that was
     * cancelled half way is finished by the next one. The mission is armed once the device was asked for all of them
     * or refused one; answers `null` then, otherwise the answer that stopped it.
     */
    private suspend fun armWatches(missions: MutableList<WakeMission>, index: Int): DeviceAlarmScheduling? {
        var stopped: DeviceAlarmScheduling? = null
        for (ring in WakeMissionRules.watchRings(missions[index]).drop(missions[index].watchIds.size)) {
            val scheduling = schedule(ring.epochSeconds)
            if (scheduling !is DeviceAlarmScheduling.Scheduled) {
                stopped = scheduling
                break
            }
            missions[index] = missions[index].copy(watchIds = missions[index].watchIds + scheduling.id)
        }
        if (stopped !is DeviceAlarmScheduling.Failed) missions[index] = missions[index].copy(armed = true)
        return stopped
    }
}
