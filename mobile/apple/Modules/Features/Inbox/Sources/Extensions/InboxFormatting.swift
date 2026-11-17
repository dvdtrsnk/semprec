import Foundation

/// Dates and times of the Inbox as the person reads them. The server speaks `yyyy-MM-dd` and `HH:mm`.
enum InboxFormatting {

    // MARK: - Days
    /// The day of an ISO text as a short date with its weekday (`Fri 16. 10. 2026`), or nil for a text that is none.
    static func day(_ iso: String?, locale: Locale = .current) -> String? {
        guard let iso, let date = date(iso) else { return nil }
        let style = Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, timeZone: .gmt)
            .weekday(.abbreviated).day().month(.defaultDigits).year()
        return date.formatted(style)
    }

    /// The time of an `HH:mm` text in the person's style, or nil for a text that is none.
    static func time(_ hhmm: String?, locale: Locale = .current) -> String? {
        guard let hhmm, let parts = parts(of: hhmm) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let components = DateComponents(year: 2000, month: 1, day: 1, hour: parts.hour, minute: parts.minute)
        guard let date = calendar.date(from: components) else { return nil }
        let style = Date.FormatStyle(
            date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: .gmt
        )
        return date.formatted(style)
    }

    /// Today as an ISO day, where the date picker opens when a field has no day yet.
    static func today(now: Date = Date()) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// The day and the time of a capture, `16. 10. 8:12`.
    static func captured(date isoDay: String?, time hhmm: String?, locale: Locale = .current) -> String? {
        let parts = [day(isoDay, locale: locale), time(hhmm, locale: locale)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    // MARK: - Parsing
    private static func date(_ iso: String) -> Date? {
        let pieces = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar.date(from: DateComponents(year: pieces[0], month: pieces[1], day: pieces[2], hour: 12))
    }

    private static func parts(of hhmm: String) -> (hour: Int, minute: Int)? {
        let pieces = hhmm.split(separator: ":").compactMap { Int($0) }
        guard pieces.count >= 2, (0..<24).contains(pieces[0]), (0..<60).contains(pieces[1]) else { return nil }
        return (pieces[0], pieces[1])
    }
}
