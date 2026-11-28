package cz.alldots.app.sdk

import cz.alldots.app.core.InMemorySleepAlarmLedger
import cz.alldots.app.core.InMemoryWakeStorage
import cz.alldots.app.core.UnavailableDeviceAlarms
import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpSleepRepository
import cz.alldots.app.presentation.SleepAlarmSync
import cz.alldots.app.presentation.SleepAlarmSyncFactory
import cz.alldots.app.presentation.SleepViewModel
import cz.alldots.app.presentation.SleepViewModelFactory
import cz.alldots.app.presentation.WakeGuardViewModel
import cz.alldots.app.presentation.WakeMissions
import cz.alldots.app.presentation.WakeSettingsViewModel
import cz.alldots.app.presentation.WakeViewModelFactory

/**
 * The sleep part of [HomeSDK]: plans, night exceptions and settings, and the wake settings and guard. [wake] and
 * [sleepAlarms] are the process's, which [DevicePushSDK] owns; without them this SDK has its own that ring nothing.
 */
class SleepSDK internal constructor(
    api: AuthenticatedApi,
    wake: WakeMissions? = null,
    sleepAlarms: SleepAlarmSync? = null,
) {
    private val repository = HttpSleepRepository(api)
    private val viewModels = SleepViewModelFactory(repository)
    private val wakeMissions = wake ?: WakeMissions(InMemoryWakeStorage(), UnavailableDeviceAlarms())
    private val wakeViewModels = WakeViewModelFactory(
        wakeMissions,
        sleepAlarms ?: SleepAlarmSyncFactory(
            repository,
            UnavailableDeviceAlarms(),
            InMemorySleepAlarmLedger(),
            wakeMissions,
        ).sleepAlarmSync(),
    )

    /** The sleep sheet for the evening [night] (`YYYY-MM-DD`, or `null`); [startOnNight] opens it on that night. */
    fun sleepViewModel(night: String?, startOnNight: Boolean): SleepViewModel =
        viewModels.sleepViewModel(night, startOnNight)

    /** The wake settings of this device. */
    fun wakeSettingsViewModel(): WakeSettingsViewModel = wakeViewModels.wakeSettingsViewModel()

    /** The guard of one window, which covers it while a wake mission rings. */
    fun wakeGuardViewModel(): WakeGuardViewModel = wakeViewModels.wakeGuardViewModel()
}
