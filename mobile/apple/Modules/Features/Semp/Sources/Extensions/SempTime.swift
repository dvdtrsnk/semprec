import Foundation

/// Writing the instants and durations the server sends the way the person reads them.
enum SempTime {

    // MARK: - Parsing
    /// The instant of an ISO 8601 text such as `2026-10-21T13:24:06.123456Z`; nil for any other text.
    static func date(_ iso: String) -> Date? {
        let milliseconds = iso.replacing(/\.(\d{3})\d+/) { ".\($0.output.1)" }
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let parsed = try? withFraction.parse(milliseconds) { return parsed }
        return try? Date.ISO8601FormatStyle().parse(iso)
    }

    // MARK: - Writing
    /// The clock time of an instant, `13:24`.
    static func clock(_ iso: String, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let value = date(iso) else { return nil }
        var style = Date.FormatStyle.dateTime.hour().minute()
        style.locale = locale
        style.timeZone = timeZone
        return value.formatted(style)
    }

    /// How long ago an instant was: `2 minutes ago`.
    static func ago(_ iso: String, now: Date = .now, locale: Locale = .current) -> String? {
        guard let value = date(iso) else { return nil }
        let style = RelativeDateTimeFormatter()
        style.locale = locale
        style.unitsStyle = .short
        return style.localizedString(for: value, relativeTo: now)
    }

    /// The day of an instant for a list: the clock time today, the weekday within the last week, the date before.
    static func listLabel(
        _ iso: String,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String? {
        guard let value = date(iso) else { return nil }
        func write(_ style: Date.FormatStyle) -> String {
            var style = style
            style.locale = locale
            style.timeZone = calendar.timeZone
            return value.formatted(style)
        }
        if calendar.isDate(value, inSameDayAs: now) { return write(.dateTime.hour().minute()) }
        let start = calendar.startOfDay(for: value)
        let days = calendar.dateComponents([.day], from: start, to: calendar.startOfDay(for: now))
        if let gone = days.day, gone > 0, gone < 7 { return write(.dateTime.weekday(.abbreviated)) }
        return write(.dateTime.day().month(.defaultDigits))
    }

    /// The start of an instant written in full: `today 13:24`, or the date and the time.
    static func started(_ iso: String, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current)
        -> String? {
        guard let value = date(iso) else { return nil }
        let clock = value.formatted(.dateTime.hour().minute().locale(locale))
        if calendar.isDate(value, inSameDayAs: now) {
            return String(format: String(localized: "semp.time.today", bundle: .module), locale: locale, clock)
        }
        let day = value.formatted(.dateTime.day().month(.defaultDigits).locale(locale))
        return "\(day) \(clock)"
    }

    /// A length of time: `4.1 s` below a minute, `2 min 5 s` above.
    static func duration(milliseconds: Int64, locale: Locale = .current) -> String {
        let seconds = Double(milliseconds) / 1_000
        if seconds < 60 {
            let number = seconds.formatted(.number.precision(.fractionLength(0...1)).locale(locale))
            return String(format: String(localized: "semp.duration.seconds", bundle: .module), locale: locale, number)
        }
        let minutes = Int(seconds) / 60
        let rest = Int(seconds) % 60
        let format = String(localized: "semp.duration.minutes", bundle: .module)
        return String(format: format, locale: locale, minutes, rest)
    }

    /// The cost of a run in US dollars: `$0.021`.
    static func cost(_ usd: Double, locale: Locale = .current) -> String {
        usd.formatted(.currency(code: "USD").precision(.fractionLength(2...3)).locale(locale))
    }
}
