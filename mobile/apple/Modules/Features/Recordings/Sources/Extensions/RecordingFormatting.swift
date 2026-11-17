import Foundation

/// How the recordings screens write times, dates and names. All of it follows the device's locale and time zone.
enum RecordingFormatting {

    /// `3:05` below an hour, `1:21:07` from an hour on.
    static func clock(_ seconds: Int) -> String {
        let total = max(seconds, 0)
        let hours = total / 3_600
        let minutes = total % 3_600 / 60
        let rest = total % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, rest) }
        return String(format: "%d:%02d", minutes, rest)
    }

    /// The moment an ISO date-time names, or nil when it is none.
    static func moment(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: iso) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso)
    }

    /// A short day and time, such as `Fri 16. 10. 10:02`.
    static func when(_ iso: String?, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        moment(iso).map { format($0, template: "EEEdMHmm", locale: locale, timeZone: timeZone) }
    }

    /// A day, such as `16. 10. 2026`.
    static func day(_ iso: String?, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        moment(iso).map { format($0, template: "dMy", locale: locale, timeZone: timeZone) }
    }

    /// The name of a language in the device's language: `cs` is `Czech`.
    static func language(_ code: String?, locale: Locale = .current) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return locale.localizedString(forLanguageCode: code)
    }

    /// The day of an event (`YYYY-MM-DD`) written out, such as `Friday 16 October 2026`.
    static func eventDay(_ day: String?, locale: Locale = .current) -> String? {
        guard let day, let date = localDate(day) else { return nil }
        return format(date, template: "EEEEdMMMMy", locale: locale, timeZone: .current)
    }

    /// The time of an event: `10:00-11:30`, `10:00` or nil for an all-day event.
    static func eventTimes(from start: String?, to end: String?) -> String? {
        guard let start else { return nil }
        guard let end else { return start }
        return "\(start)\u{2013}\(end)"
    }

    /// A due date of an action item (`YYYY-MM-DD`) as a short day and month, or the text as it came.
    static func due(_ value: String?, locale: Locale = .current) -> String? {
        guard let value else { return nil }
        guard let date = localDate(value) else { return value }
        return format(date, template: "dM", locale: locale, timeZone: .current)
    }

    /// The first letters of a name, such as `JK` for `Jana Kovarova`.
    static func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
        return String(letters).uppercased()
    }

    // MARK: - Private
    private static func localDate(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        return Calendar.current.date(from: components)
    }

    private static func format(_ date: Date, template: String, locale: Locale, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}
