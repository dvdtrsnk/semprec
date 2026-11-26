package cz.semprec.app.sdk

import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.HeldDeviceAlarm
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.core.InMemoryWakeStorage
import cz.semprec.app.core.WakeMission
import cz.semprec.app.presentation.SleepAlarmSyncResult
import cz.semprec.app.presentation.WakeGuardPhase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class HoldingAlarms : DeviceAlarms {
    val cancelled = mutableListOf<String>()

    override fun authorization() = DeviceAlarmAuthorization.AUTHORIZED

    override fun schedule(
        ringAtEpochSeconds: Long,
        opensWakeGuard: Boolean,
        callback: (DeviceAlarmScheduling) -> Unit,
    ) =
        callback(DeviceAlarmScheduling.Failed)

    override fun cancel(id: String): Boolean = cancelled.add(id)

    override fun held(callback: (List<HeldDeviceAlarm>?) -> Unit) =
        callback(listOf(HeldDeviceAlarm("a1", DeviceAlarmPhase.SCHEDULED)))
}

@OptIn(ExperimentalCoroutinesApi::class)
class DevicePushSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `the sleep alarms ring through the alarms and the ledger the app wired in`() = runTest(dispatcher) {
        val alarms = HoldingAlarms()
        val ledger = InMemorySleepAlarmLedger().also { it.save(mapOf("sleep:k" to "a1")) }

        val result = DevicePushSDK(alarms = alarms, sleepAlarmLedger = ledger).sleepAlarms.signedOut()

        assertEquals(SleepAlarmSyncResult.SYNCED, result)
        assertEquals(listOf("a1"), alarms.cancelled)
        assertTrue(ledger.load().isEmpty())
    }

    @Test fun `the wake missions come from the storage the app wired in and are shared with the windows`() =
        runTest(dispatcher) {
            val storage = InMemoryWakeStorage()
            storage.saveMissions(listOf(WakeMission("sleep:k", 100, "a1", listOf("1"))))
            val push = DevicePushSDK(wakeStorage = storage)

            val guard = HomeSDK(wake = push.wake, sleepAlarms = push.sleepAlarms).sleep.wakeGuardViewModel()

            assertEquals(listOf("sleep:k"), push.wake.missions.value.map { it.key })
            runCurrent()
            assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase)
            guard.close()
        }

    @Test fun `a device with no alarms wired in has none to keep in step`() = runTest(dispatcher) {
        assertEquals(SleepAlarmSyncResult.UNSUPPORTED, DevicePushSDK().sleepAlarms.sync())
    }
}
