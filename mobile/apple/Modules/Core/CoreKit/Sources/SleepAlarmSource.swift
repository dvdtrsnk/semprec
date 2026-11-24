import Foundation

/// One alarm of the sleep plan the device rings: `wakeDay` (`YYYY-MM-DD`) at `wakeMinutes` after midnight; `night` is
/// the evening the night starts and `planName` the plan it follows, if any.
public struct SleepAlarmTime: Equatable, Sendable {

    public let night: String
    public let wakeDay: String
    public let wakeMinutes: Int
    public let planName: String?

    public init(night: String, wakeDay: String, wakeMinutes: Int, planName: String?) {
        self.night = night
        self.wakeDay = wakeDay
        self.wakeMinutes = wakeMinutes
        self.planName = planName
    }
}

/// Where the device reads the alarms of the sleep plan it rings itself.
@MainActor
public protocol SleepAlarmSource: AnyObject {

    /// The alarms from the morning of `today` (`YYYY-MM-DD`) for a week, soonest first; nil when they could not be
    /// read, so the alarms the device holds stay.
    func sleepAlarms(today: String) async -> [SleepAlarmTime]?

    /// Whether a silent push with `payload` tells the device that the sleep plan changed.
    func asksForSleepAlarms(_ payload: [String: String]) -> Bool
}
