import Foundation

/// Times of day as the shared layer takes them: `HH:mm`, read and written on today in the calendar of this device,
/// so that a native time picker can edit them.
public enum ClockTime {

    /// `date`'s time of day, `HH:mm`.
    public static func string(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    /// Today at `text` (`HH:mm`), or nil for text that is no time of day.
    public static func date(from text: String, on day: Date = .now) -> Date? {
        let numbers = text.split(separator: ":").compactMap { Int($0) }
        guard numbers.count == 2, (0..<24).contains(numbers[0]), (0..<60).contains(numbers[1]) else { return nil }
        return Calendar.current.date(bySettingHour: numbers[0], minute: numbers[1], second: 0, of: day)
    }
}
