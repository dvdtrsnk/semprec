import Foundation

/// The part of one night of sleep that falls on one day. The times are minutes of the day; the night starts on the
/// evening `night`. The band on this day runs from `fromMinutes` to `toMinutes` and is empty when they are equal;
/// `prepMinutes` is when the bedtime reminder comes on this day. `planBedMinutes` and `planWakeMinutes` are the plan's
/// times the night follows or departs from (`nil` without a plan); `meetsGoal` tells whether the night is at least as
/// long as `goalMinutes` (`nil` without a goal).
public struct CalendarSleep: Equatable, Sendable {

    public let night: String
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let alarm: Bool
    public let changed: Bool
    public let prepMinutes: Int?
    public let fromMinutes: Int
    public let toMinutes: Int
    public let planBedMinutes: Int?
    public let planWakeMinutes: Int?
    public let durationMinutes: Int
    public let goalMinutes: Int?
    public let meetsGoal: Bool?

    public init(
        night: String,
        bedMinutes: Int,
        wakeMinutes: Int,
        alarm: Bool,
        changed: Bool,
        prepMinutes: Int?,
        fromMinutes: Int,
        toMinutes: Int,
        planBedMinutes: Int? = nil,
        planWakeMinutes: Int? = nil,
        durationMinutes: Int = 0,
        goalMinutes: Int? = nil,
        meetsGoal: Bool? = nil
    ) {
        self.night = night
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.alarm = alarm
        self.changed = changed
        self.prepMinutes = prepMinutes
        self.fromMinutes = fromMinutes
        self.toMinutes = toMinutes
        self.planBedMinutes = planBedMinutes
        self.planWakeMinutes = planWakeMinutes
        self.durationMinutes = durationMinutes
        self.goalMinutes = goalMinutes
        self.meetsGoal = meetsGoal
    }
}
