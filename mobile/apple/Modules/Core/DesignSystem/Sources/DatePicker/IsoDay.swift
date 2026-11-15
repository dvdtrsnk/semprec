import Foundation

/// A calendar day as the app and the server write it: `yyyy-MM-dd` in the proleptic Gregorian calendar. The picker
/// reads and writes this text, so a day never depends on a time zone.
struct IsoDay: Equatable, Sendable {

    // MARK: - Properties
    let year: Int
    /// 1 to 12.
    let month: Int
    /// 1 to the length of the month.
    let day: Int

    // MARK: - Init
    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// The day written as `text`, or nil when `text` is not `yyyy-MM-dd` or names a day that does not exist.
    init?(_ text: String) {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
            parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            (1...12).contains(month),
            (1...MonthGrid.length(year: year, month: month)).contains(day)
        else { return nil }
        self.init(year: year, month: month, day: day)
    }

    // MARK: - Methods
    /// `yyyy-MM-dd`, zero padded.
    var text: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// The day as a `Date` at noon UTC, for formatting with the user's calendar.
    var date: Date {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = 12
        return MonthGrid.gregorian.date(from: parts) ?? Date(timeIntervalSince1970: 0)
    }
}
