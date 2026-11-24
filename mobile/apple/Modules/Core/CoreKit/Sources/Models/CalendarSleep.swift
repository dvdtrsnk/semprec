import Foundation

/// The part of one night of sleep that falls on one day. The times are minutes of the day; the night belongs to the
/// evening `night`. The band on this day runs from `fromMinutes` to `toMinutes` and is empty when they are equal;
/// `prepMinutes` is the bedtime reminder when it comes on this day.
public struct CalendarSleep: Equatable, Sendable {

    public let night: String
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let alarm: Bool
    public let changed: Bool
    public let prepMinutes: Int?
    public let fromMinutes: Int
    public let toMinutes: Int

    public init(
        night: String,
        bedMinutes: Int,
        wakeMinutes: Int,
        alarm: Bool,
        changed: Bool,
        prepMinutes: Int?,
        fromMinutes: Int,
        toMinutes: Int
    ) {
        self.night = night
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.alarm = alarm
        self.changed = changed
        self.prepMinutes = prepMinutes
        self.fromMinutes = fromMinutes
        self.toMinutes = toMinutes
    }
}
