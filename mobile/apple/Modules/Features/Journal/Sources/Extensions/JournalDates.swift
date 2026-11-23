import CoreKit
import Foundation

/// Reads and writes the days the shared layer names as `YYYY-MM-DD` and formats them for the person's locale. The
/// days are calendar days without a zone, so every calculation here runs in UTC and never shifts a day.
@MainActor
enum JournalDates {

    // MARK: - Properties
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        calendar.locale = .current
        return calendar
    }()
    private static var formatters: [String: DateFormatter] = [:]
    /// Made once: a formatter is costly to make, and the cards of a month ask for a range each.
    private static let weekRangeFormatter: DateIntervalFormatter = {
        let formatter = DateIntervalFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = .current
        formatter.dateTemplate = "dM"
        return formatter
    }()

    // MARK: - Parsing
    /// The device's current day. The server answers with its own today, which the diary adopts once it is loaded.
    static func deviceToday(now: Date = Date()) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    static func date(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// The start of the period of `kind` `steps` periods after the one that starts on `start`: the next day, month or
    /// year, or the ones before it for a negative `steps`.
    static func shifted(_ start: String, kind: JournalPeriodKind, by steps: Int) -> String? {
        guard let first = date(start) else { return nil }
        let component: Calendar.Component
        var amount = steps
        switch kind {
        case .day: component = .day
        case .week: component = .day
            amount = steps * 7
        case .month: component = .month
        case .quarter: component = .month
            amount = steps * 3
        case .year: component = .year
        }
        guard let shifted = calendar.date(byAdding: component, value: amount, to: first) else { return nil }
        let parts = calendar.dateComponents([.year, .month, .day], from: shifted)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    // MARK: - Titles
    /// `pátek 16. října`, capitalized.
    static func dayTitle(_ key: String) -> String {
        format(key, template: "EEEEdMMMM")
    }

    /// `Říjen 2026`.
    static func monthTitle(_ key: String) -> String {
        format(key, template: "LLLLy")
    }

    /// `Q4 2026` for the quarter that starts on `start`.
    static func quarterTitle(start: String) -> String {
        guard let date = date(start) else { return start }
        let parts = calendar.dateComponents([.year, .month], from: date)
        return "Q\(((parts.month ?? 1) - 1) / 3 + 1) \(parts.year ?? 0)"
    }

    /// The calendar year of a day.
    static func year(_ key: String) -> Int {
        date(key).map { calendar.component(.year, from: $0) } ?? 0
    }

    /// The months a quarter spans: `Říjen – Prosinec`.
    static func quarterSpan(start: String) -> String {
        guard let first = date(start), let last = calendar.date(byAdding: .month, value: 2, to: first) else {
            return start
        }
        return "\(formatted(first, template: "LLLL")) – \(formatted(last, template: "LLLL"))"
    }

    /// The week's days: `12.–18. 10.`.
    static func weekRange(first: String, last: String) -> String {
        guard let start = date(first), let end = date(last) else { return "\(first) – \(last)" }
        return weekRangeFormatter.string(from: start, to: end)
    }

    // MARK: - Axis labels
    /// `Po`, from the ISO weekday (1 for Monday up to 7 for Sunday).
    static func weekdayShort(_ isoWeekday: Int) -> String {
        let symbols = calendar.shortStandaloneWeekdaySymbols
        return capitalized(symbols[isoWeekday % symbols.count])
    }

    /// `Říj`, from the month number 1 to 12.
    static func monthShort(_ month: Int) -> String {
        let symbols = calendar.shortStandaloneMonthSymbols
        return capitalized(symbols[(month - 1) % symbols.count])
    }

    /// `9:05` for minutes since midnight.
    static func clock(minutes: Int) -> String {
        String(format: "%d:%02d", minutes / 60, minutes % 60)
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
