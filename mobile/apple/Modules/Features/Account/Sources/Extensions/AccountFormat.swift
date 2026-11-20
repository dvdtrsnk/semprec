import Foundation

/// How the account screens word values. All of them take the locale so that a test fixes it.
enum AccountFormat {

    // MARK: - Money
    /// A price in US dollars with two decimals and the separator of `locale`: `$24.12` or `$24,12`.
    static func usd(_ value: Double, locale: Locale = .current) -> String {
        "$" + value.formatted(.number.precision(.fractionLength(2)).locale(locale))
    }

    // MARK: - Dates
    /// The instant an ISO 8601 text (with or without fractions of a second) names, or nil for any other text.
    static func instant(_ iso: String) -> Date? {
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return plain.date(from: iso) ?? fractional.date(from: iso)
    }

    /// How long ago `iso` was, as `RelativeDateTimeFormatter` words it ("2 hours ago"), or nil for a text that is no
    /// instant.
    static func relative(_ iso: String, now: Date = .now, locale: Locale = .current) -> String? {
        guard let date = instant(iso) else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// The day `iso` falls on, numeric ("12. 9. 2026").
    static func day(_ iso: String, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let date = instant(iso) else { return nil }
        return date.formatted(Date.FormatStyle(date: .numeric, time: .omitted, locale: locale, timeZone: timeZone))
    }

    /// The weekday, day, month and clock time of an account's last sync, or nil for a text that is no instant. The
    /// server writes microseconds, which the system parser does not take, so the fraction is dropped.
    static func syncTime(_ iso: String?, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let iso, let date = instant(iso.replacing(/\.\d+/, with: "")) else { return nil }
        var style = Date.FormatStyle(locale: locale, timeZone: timeZone)
        style = style.weekday(.abbreviated).day().month().hour().minute()
        return date.formatted(style)
    }

    // MARK: - Identity
    /// The initials of the display name as the person's locale abbreviates a name; without a name, the first letters
    /// of the first two words of the part of the address before the `@`, capitalized.
    static func initials(name: String? = nil, email: String?) -> String {
        if let name {
            let formatter = PersonNameComponentsFormatter()
            if let parts = formatter.personNameComponents(from: name) {
                formatter.style = .abbreviated
                let initials = formatter.string(from: parts)
                if !initials.isEmpty { return initials }
            }
        }
        guard let email else { return "" }
        let words = email.prefix { $0 != "@" }.split { !$0.isLetter && !$0.isNumber }
        return words.prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
    }

    /// The host of a server address, or the address itself when it has none.
    static func host(of serverUrl: String?) -> String? {
        guard let serverUrl else { return nil }
        return URL(string: serverUrl)?.host() ?? serverUrl
    }
}
