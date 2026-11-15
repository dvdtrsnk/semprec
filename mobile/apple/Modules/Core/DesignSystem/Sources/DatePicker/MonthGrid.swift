import Foundation

/// The days of one month laid out in weeks, for the date picker's grid.
struct MonthGrid: Equatable, Sendable {

    // MARK: - Properties
    let year: Int
    /// 1 to 12.
    let month: Int

    /// The Gregorian calendar in UTC that every day computation uses.
    static let gregorian: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return calendar
    }()

    // MARK: - Methods
    /// The number of days of `month` in `year`.
    static func length(year: Int, month: Int) -> Int {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = 1
        guard let first = gregorian.date(from: parts), let days = gregorian.range(of: .day, in: .month, for: first)
        else { return 0 }
        return days.count
    }

    /// The month `offset` months after this one; a negative offset goes back.
    func shifted(by offset: Int) -> MonthGrid {
        let index = year * 12 + (month - 1) + offset
        return MonthGrid(year: index / 12, month: index % 12 + 1)
    }

    /// The day numbers of the month in weeks of seven, with nil for the days of the neighbouring months, the week
    /// starting on `firstWeekday` (1 is Sunday, 2 is Monday, as `Calendar.firstWeekday` numbers them).
    func cells(firstWeekday: Int) -> [Int?] {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = 1
        guard let first = Self.gregorian.date(from: parts) else { return [] }
        let weekdayOfFirst = Self.gregorian.component(.weekday, from: first)
        let leading = (weekdayOfFirst - firstWeekday + 7) % 7
        var cells: [Int?] = Array(repeating: nil, count: leading)
        cells += (1...Self.length(year: year, month: month)).map { Optional($0) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    /// The name of the month and the year in the language of `calendar`, such as "October 2026".
    func title(calendar: Calendar) -> String {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = 1
        parts.hour = 12
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = calendar.locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("LLLL yyyy")
        return formatter.string(from: Self.gregorian.date(from: parts) ?? Date(timeIntervalSince1970: 0))
    }
}
