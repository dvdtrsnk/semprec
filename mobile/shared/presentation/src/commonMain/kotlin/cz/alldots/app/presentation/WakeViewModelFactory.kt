package cz.alldots.app.presentation

import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the wake ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the sync service they take stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class WakeViewModelFactory(private val wake: WakeMissions, private val sleepAlarms: SleepAlarmSync) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun wakeSettingsViewModel(): WakeSettingsViewModel = WakeSettingsViewModel(wake, sleepAlarms)

    /** One new guard per call, for one window. */
    fun wakeGuardViewModel(): WakeGuardViewModel = WakeGuardViewModel(wake)
}
