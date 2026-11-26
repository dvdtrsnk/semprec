import CoreKit

// MARK: - Band
extension CalendarSleep {

    /// The part of the day the night covers, as minutes of the day, or nil when this day holds none of it (only the
    /// bedtime reminder, or nothing). The shared layer cut it; this is the one place that says "empty".
    var band: Range<Int>? {
        fromMinutes < toMinutes ? fromMinutes..<toMinutes : nil
    }
}
