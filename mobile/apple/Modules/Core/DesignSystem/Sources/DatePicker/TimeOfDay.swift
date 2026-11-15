import Foundation

/// A time of day as the app and the server write it: `HH:mm`, 24 hours.
struct TimeOfDay: Equatable, Sendable {

    // MARK: - Properties
    /// 0 to 23.
    let hour: Int
    /// 0 to 59.
    let minute: Int

    /// The minutes the wheel offers besides the current one.
    static let minuteStep = 5

    // MARK: - Init
    init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }

    /// The time written as `text` (`H:mm` or `HH:mm`), or nil when it is not a time of day.
    init?(_ text: String) {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, (1...2).contains(parts[0].count), parts[1].count == 2,
            let hour = Int(parts[0]), let minute = Int(parts[1]),
            (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        self.init(hour: hour, minute: minute)
    }

    // MARK: - Methods
    /// `HH:mm`, zero padded.
    var text: String {
        String(format: "%02d:%02d", hour, minute)
    }

    /// The hours of the hour wheel.
    static var hours: [Int] { Array(0..<24) }

    /// The minutes of the minute wheel: every fifth minute, and the current one when it is not among them.
    func minutes() -> [Int] {
        var minutes = Array(stride(from: 0, to: 60, by: Self.minuteStep))
        if !minutes.contains(minute) {
            minutes.append(minute)
            minutes.sort()
        }
        return minutes
    }
}
