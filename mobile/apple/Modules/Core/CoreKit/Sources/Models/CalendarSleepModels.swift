import Foundation

/// One night of sleep as it is drawn. The times are minutes of the day; the night starts on the evening `night`.
/// `planBedMinutes` and `planWakeMinutes` are the plan's times the night follows or departs from (`nil` without a
/// plan); `meetsGoal` tells whether the night is at least as long as `goalMinutes` (`nil` without a goal).
public struct CalendarSleep: Equatable, Sendable {

    public let night: String
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let alarm: Bool
    public let changed: Bool
    public let prepMinutes: Int?
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
        self.planBedMinutes = planBedMinutes
        self.planWakeMinutes = planWakeMinutes
        self.durationMinutes = durationMinutes
        self.goalMinutes = goalMinutes
        self.meetsGoal = meetsGoal
    }
}

/// The night a finger moves or stretches, and the snapped times it would have.
public struct CalendarSleepDrag: Equatable, Sendable {

    public let night: String
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let committing: Bool

    public init(night: String, bedMinutes: Int, wakeMinutes: Int, committing: Bool) {
        self.night = night
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.committing = committing
    }
}
