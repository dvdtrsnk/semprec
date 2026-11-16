import Foundation

/// Formats when an invitation takes place from its ISO instants, in the zone the invitation names and the person's
/// locale: `pá 23. 10. · 19:00–22:00` in Czech, `Fri, 10/23 · 7:00 PM–10:00 PM` in American English.
enum InvitationDates {

    // MARK: - Parsing
    /// The instant of an ISO 8601 timestamp, with or without fractional seconds; `nil` for anything else.
    static func instant(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }

    // MARK: - Formatting
    /// The day and the time of an invitation, or `nil` when it has no readable start. An all-day invitation shows its
    /// day (or its first and last day) followed by `allDay`; its end is the exclusive midnight after its last day. An
    /// unknown zone falls back to the device's zone.
    static func when(
        startsAt: String?,
        endsAt: String?,
        timeZone: String?,
        allDay: Bool,
        allDayText: String,
        locale: Locale = .current
    ) -> String? {
        guard let start = startsAt.flatMap(instant) else { return nil }
        let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        let style = Style(zone: zone, locale: locale)
        let end = endsAt.flatMap(instant).flatMap { $0 > start ? $0 : nil }
        if allDay {
            let last = end.map { $0.addingTimeInterval(-1) } ?? start
            guard !style.sameDay(start, last) else { return "\(style.day(start)) · \(allDayText)" }
            return "\(style.day(start)) – \(style.day(last)) · \(allDayText)"
        }
        guard let end else { return "\(style.day(start)) · \(style.time(start))" }
        guard style.sameDay(start, end) else {
            return "\(style.day(start)) · \(style.time(start)) – \(style.day(end)) \(style.time(end))"
        }
        return "\(style.day(start)) · \(style.time(start))–\(style.time(end))"
    }
}

// MARK: - Style
private extension InvitationDates {

    /// The formatters of one zone and locale.
    struct Style {

        let calendar: Calendar
        let dayFormatter: DateFormatter
        let timeFormatter: DateFormatter

        init(zone: TimeZone, locale: Locale) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            calendar.locale = locale
            self.calendar = calendar
            dayFormatter = Self.formatter(template: "EEEdM", calendar: calendar)
            timeFormatter = Self.formatter(template: "jm", calendar: calendar)
        }

        func day(_ date: Date) -> String {
            dayFormatter.string(from: date)
        }

        func time(_ date: Date) -> String {
            timeFormatter.string(from: date)
        }

        func sameDay(_ first: Date, _ second: Date) -> Bool {
            calendar.isDate(first, inSameDayAs: second)
        }

        static func formatter(template: String, calendar: Calendar) -> DateFormatter {
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.locale = calendar.locale
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter
        }
    }
}
