import Foundation

/// Reads and writes the days the shared layer names as `YYYY-MM-DD` and formats them for the person's locale. The
/// days are calendar days without a zone, so every calculation here runs in UTC and never shifts a day.
@MainActor
enum CalendarDates {

    // MARK: - Properties
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        calendar.locale = .current
        calendar.firstWeekday = 2
        return calendar
    }()
    private static var formatters: [String: DateFormatter] = [:]

    // MARK: - Parsing
    /// The device's current day. The server answers with its own today, which the calendar adopts once loaded.
    static func deviceToday(now: Date = Date()) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    static func date(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func key(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// The day `days` away from `key`.
    static func shifted(_ key: String, by days: Int) -> String {
        guard let start = date(key), let moved = calendar.date(byAdding: .day, value: days, to: start) else {
            return key
        }
        return Self.key(moved)
    }

    /// The Monday of the week `key` is in.
    static func monday(of key: String) -> String {
        shifted(key, by: 1 - isoWeekday(key))
    }

    /// How many days `end` is after `start`; negative when it is before.
    static func days(from start: String, to end: String) -> Int {
        guard let start = date(start), let end = date(end) else { return 0 }
        return calendar.dateComponents([.day], from: start, to: end).day ?? 0
    }

    // MARK: - Parts
    /// The day of the month, `16`.
    static func dayNumber(_ key: String) -> Int {
        date(key).map { calendar.component(.day, from: $0) } ?? 0
    }

    /// 1 for Monday up to 7 for Sunday.
    static func isoWeekday(_ key: String) -> Int {
        guard let date = date(key) else { return 1 }
        return (calendar.component(.weekday, from: date) + 5) % 7 + 1
    }

    /// The ISO 8601 week number: weeks start on Monday and week 1 holds the year's first Thursday.
    static func isoWeek(_ key: String) -> Int {
        var iso = Calendar(identifier: .iso8601)
        iso.timeZone = calendar.timeZone
        return date(key).map { iso.component(.weekOfYear, from: $0) } ?? 0
    }

    static func year(_ key: String) -> Int {
        date(key).map { calendar.component(.year, from: $0) } ?? 0
    }

    static func month(_ key: String) -> Int {
        date(key).map { calendar.component(.month, from: $0) } ?? 0
    }

    /// The first day of the month of `key`.
    static func firstOfMonth(_ key: String) -> String {
        guard let date = date(key),
            let first = calendar.date(from: calendar.dateComponents([.year, .month], from: date))
        else { return key }
        return Self.key(first)
    }

    // MARK: - Titles
    /// `pátek 16. října`, capitalized.
    static func dayTitle(_ key: String) -> String {
        format(key, template: "EEEEdMMMM")
    }

    /// `Říjen`, the month of `key` alone.
    static func monthName(_ key: String) -> String {
        format(key, template: "LLLL")
    }

    /// `Říjen`, from the month number 1 to 12.
    static func monthName(month: Int) -> String {
        let symbols = calendar.standaloneMonthSymbols
        return capitalized(symbols[(month - 1 + symbols.count) % symbols.count])
    }

    /// `Po`, from the ISO weekday (1 for Monday up to 7 for Sunday).
    static func weekdayShort(_ isoWeekday: Int) -> String {
        let symbols = calendar.shortStandaloneWeekdaySymbols
        return capitalized(symbols[isoWeekday % symbols.count])
    }

    /// `pá 16. 10.`, the way the board writes a date next to a time.
    static func shortDate(_ key: String) -> String {
        guard let date = date(key) else { return key }
        let weekday = calendar.shortStandaloneWeekdaySymbols[calendar.component(.weekday, from: date) - 1]
        let parts = calendar.dateComponents([.day, .month], from: date)
        return "\(weekday) \(parts.day ?? 0). \(parts.month ?? 0)."
    }

    /// `9:05` for minutes since midnight; 24:00 closes a day.
    static func clock(minutes: Int) -> String {
        String(format: "%d:%02d", minutes / 60, minutes % 60)
    }

    /// `14:00–15:30`.
    static func range(from start: Int, to end: Int) -> String {
        "\(clock(minutes: start))–\(clock(minutes: end))"
    }

    // MARK: - Private
    private static func format(_ key: String, template: String) -> String {
        guard let date = date(key) else { return key }
        return formatted(date, template: template)
    }

    private static func formatted(_ date: Date, template: String) -> String {
        let formatter = formatters[template] ?? {
            let made = DateFormatter()
            made.calendar = calendar
            made.timeZone = calendar.timeZone
            made.locale = .current
            made.setLocalizedDateFormatFromTemplate(template)
            formatters[template] = made
            return made
        }()
        return capitalized(formatter.string(from: date))
    }

    private static func capitalized(_ text: String) -> String {
        text.prefix(1).localizedUppercase + text.dropFirst()
    }
}
