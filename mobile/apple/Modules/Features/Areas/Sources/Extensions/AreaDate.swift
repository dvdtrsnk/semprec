import Foundation

/// Writes the day and time of an upcoming task or event the way the app shows them: the day before, today and
/// tomorrow by name, any other day by its short weekday, day and month, then the time or the time range.
struct AreaDate {

    // MARK: - Properties
    let now: Date
    var calendar: Calendar = .current
    var locale: Locale = .current

    // MARK: - Methods
    /// "Today 14:00-15:30", "Thu 22. 10.", ... or nil when there is neither a day nor a time.
    func when(date: String?, timeFrom: String?, timeTo: String?) -> String? {
        let day = date.flatMap { text(iso: $0) }
        let time = timeFrom.map { from in timeTo.map { "\(from)\u{2013}\($0)" } ?? from }
        let parts = [day, time].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// Whether the canonical date `iso` (`yyyy-MM-dd`) is before today.
    func isLate(iso: String?) -> Bool {
        guard let iso, let date = Self.date(iso: iso, calendar: calendar) else { return false }
        return date < calendar.startOfDay(for: now)
    }

    /// The text for the canonical date `iso`, or nil when `iso` is not a date.
    func text(iso: String) -> String? {
        guard let date = Self.date(iso: iso, calendar: calendar) else { return nil }
        let today = calendar.startOfDay(for: now)
        switch calendar.dateComponents([.day], from: today, to: date).day {
        case -1: return String(localized: "date.yesterday", bundle: .module, locale: locale)
        case 0: return String(localized: "date.today", bundle: .module, locale: locale)
        case 1: return String(localized: "date.tomorrow", bundle: .module, locale: locale)
        default:
            return date.formatted(
                Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: calendar)
                    .weekday(.abbreviated)
                    .day()
                    .month(.defaultDigits)
            )
        }
    }

    // MARK: - Private
    private static func date(iso: String, calendar: Calendar) -> Date? {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
