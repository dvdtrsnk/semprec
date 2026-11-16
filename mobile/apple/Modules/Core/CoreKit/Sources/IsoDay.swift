import Foundation

/// Calendar days as the shared layer takes them: `yyyy-MM-dd`, in the calendar and time zone of this device.
public enum IsoDay {

    /// Today, `yyyy-MM-dd`.
    public static func today() -> String {
        string(from: Date.now)
    }

    /// The day `date` falls on in the calendar of this device, `yyyy-MM-dd`.
    public static func string(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 1, parts.day ?? 1)
    }

    /// The moment a `yyyy-MM-dd` day starts in the calendar of this device, or nil for text that is no day.
    public static func date(from text: String) -> Date? {
        let numbers = text.split(separator: "-").compactMap { Int($0) }
        guard numbers.count == 3 else { return nil }
        let parts = DateComponents(year: numbers[0], month: numbers[1], day: numbers[2])
        return Calendar.current.date(from: parts)
    }
}
