import Foundation

/// Writes canonical dates the way the app shows them: the day before, today and tomorrow by name, any other day by its
/// short weekday, day and month ("Thu 22. 10."), in the language and calendar of the person.
struct DisplayDate {

    // MARK: - Properties
    let now: Date
    var calendar: Calendar = .current
    var locale: Locale = .current

    // MARK: - Methods
    /// The text for the canonical date `iso` (`YYYY-MM-DD`), or nil when `iso` is not a date.
    func text(iso: String) -> String? {
        guard let date = Self.date(iso: iso, calendar: calendar) else { return nil }
        let today = calendar.startOfDay(for: now)
        switch calendar.dateComponents([.day], from: today, to: date).day {
        case -1: return String(localized: "date.yesterday", bundle: .module, locale: locale)
        case 0: return String(localized: "date.today", bundle: .module, locale: locale)
        case 1: return String(localized: "date.tomorrow", bundle: .module, locale: locale)
        default: return shortDate(date)
        }
    }

    /// The time or time range as written: `14:00-15:30` takes an en dash.
    static func time(_ canonical: String) -> String {
        canonical.replacingOccurrences(of: "-", with: "\u{2013}")
    }

    // MARK: - Private
    private func shortDate(_ date: Date) -> String {
        date.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: calendar)
                .weekday(.abbreviated)
                .day()
                .month(.defaultDigits)
        )
    }

    private static func date(iso: String, calendar: Calendar) -> Date? {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
