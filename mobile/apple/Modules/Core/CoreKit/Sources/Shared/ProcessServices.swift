@preconcurrency internal import SharedSDK

/// What belongs to the device and not to a window: the Kotlin `DevicePushSDK` with the system's alarms, the
/// ledger and the wake storage. The process's notifications and every scene's screen model factory reach it here, so
/// that the sleep alarm sync that schedules the wake missions and the guard of each window that watches them share one
/// instance of them. Tests use `.memory` stores, which do not touch it.
@MainActor
enum ProcessServices {

    /// Created on first use, once per process.
    static let devicePush = SharedSDK.DevicePushSDK(
        sessionStorage: KeychainSessionStorage(),
        subscriptions: DefaultsPushSubscriptionStorage(),
        alarms: DeviceAlarmScheduler(),
        sleepAlarmLedger: DefaultsSleepAlarmLedger(),
        wakeStorage: DefaultsWakeStorage()
    )
}
