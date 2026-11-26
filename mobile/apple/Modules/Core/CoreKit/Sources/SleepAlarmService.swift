import Foundation

/// What the app does to keep this device's system alarms in step with the sleep plan, decided in the shared layer:
/// which alarms the plan asks for, which the device holds and which it must never remove. A run that did not finish,
/// because the task awaiting it was cancelled, answers nil.
@MainActor
public protocol SleepAlarmService: AnyObject {

    /// Reads the sleep plan and brings the device's alarms in step with it. A plan that cannot be read keeps them.
    @discardableResult
    func syncSleepAlarms() async -> SleepAlarmSyncResult?

    /// Nobody is signed in: removes the alarms of the person who was, apart from one that rings now.
    @discardableResult
    func removeSleepAlarms() async -> SleepAlarmSyncResult?
}
