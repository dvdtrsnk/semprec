package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.LoadSleepAlarms
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepAlarm
import cz.semprec.app.domain.SleepRepository
import kotlin.coroutines.cancellation.CancellationException
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * One alarm of the sleep plan the device rings: [wakeDay] (`YYYY-MM-DD`) at [wakeMinutes] after midnight; [night]
 * is the evening the night starts and [planName] the plan it follows, if any.
 */
data class DeviceSleepAlarm(val night: String, val wakeDay: String, val wakeMinutes: Int, val planName: String?)

/**
 * The alarms of the sleep plan the device rings itself, and whether a silent push asks it to read them again. A
 * failed read is `null`, so the alarms the device holds stay; cancellation is rethrown.
 */
class DeviceSleepAlarms internal constructor(private val load: LoadSleepAlarms) {
    /** The alarms from the morning of [today] (`YYYY-MM-DD`) for a week, soonest first; `null` when not read. */
    suspend fun alarms(today: String): List<DeviceSleepAlarm>? {
        val read = CalendarDay.parse(today)?.let { day -> guardedLoad(day) }
        return (read as? RepositoryResult.Content)?.value?.map {
            DeviceSleepAlarm(it.night.toString(), it.wakeDay.toString(), it.wake.minutes, it.planName)
        }
    }

    /** The read, with an unexpected exception as no answer; cancellation is rethrown. */
    private suspend fun guardedLoad(day: CalendarDay): RepositoryResult<List<SleepAlarm>>? = try {
        load(day)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    /** Whether a silent push with [payload] tells the device that the sleep plan changed. */
    fun asksForSleepAlarms(payload: Map<String, String>): Boolean = payload[KIND] == SLEEP_RESYNC

    private companion object {
        const val KIND = "kind"
        const val SLEEP_RESYNC = "sleepResync"
    }
}

/** Creates [DeviceSleepAlarms] for the SDK in the umbrella module, keeping the repository port out of Swift. */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class DeviceSleepAlarmsFactory(private val repository: SleepRepository) {
    fun deviceSleepAlarms(): DeviceSleepAlarms = DeviceSleepAlarms(LoadSleepAlarms(repository))
}
