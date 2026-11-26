@preconcurrency internal import SharedSDK

/// The state of the device that no window owns: the wake missions and the sleep alarm sync of the process. Two windows
/// each holding their own would schedule every alarm twice and ring two guards, so the process's owner of notifications
/// creates one and hands it to every scene's screen model factory. Nothing reaches it any other way, and no factory
/// creates one itself.
@MainActor
public final class DeviceServices {

    // MARK: - Dependencies
    let wake: SharedSDK.WakeMissions
    let sleepAlarms: SharedSDK.SleepAlarmSync

    // MARK: - Init
    init(wake: SharedSDK.WakeMissions, sleepAlarms: SharedSDK.SleepAlarmSync) {
        self.wake = wake
        self.sleepAlarms = sleepAlarms
    }
}
