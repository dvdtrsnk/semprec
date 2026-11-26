import Foundation

/// The night a finger moves or stretches: the snapped times it would have, and the parts it would have on its evening
/// `night` and on the morning after, `morningDay`, as the shared layer cuts them (`nil` where nothing of it falls).
public struct CalendarSleepDrag: Equatable, Sendable {

    public let night: String
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let committing: Bool
    public let evening: CalendarSleep?
    public let morning: CalendarSleep?
    public let morningDay: String

    public init(
        night: String,
        bedMinutes: Int,
        wakeMinutes: Int,
        committing: Bool,
        evening: CalendarSleep? = nil,
        morning: CalendarSleep? = nil,
        morningDay: String = ""
    ) {
        self.night = night
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.committing = committing
        self.evening = evening
        self.morning = morning
        self.morningDay = morningDay
    }
}
