import CoreKit
import Foundation

/// How the AI usage screen words periods, bars and units. Every function takes the locale so that a test fixes it.
enum AiUsageFormat {

    // MARK: - Periods
    /// The chip of a period: "7 days", "All", or the month name ("October").
    static func chip(_ period: UsagePeriod, locale: Locale = .current) -> String {
        switch period {
        case .week: String(localized: "usage.period.week", bundle: .module)
        case .all: String(localized: "usage.period.all", bundle: .module)
        case .month(let month): monthName(month, locale: locale) ?? month
        }
    }

    /// The month `yyyy-MM` as its name in `locale`, without the year ("October").
    static func monthName(_ month: String, locale: Locale = .current) -> String? {
        guard let date = monthStart(month) else { return nil }
        return date.formatted(Date.FormatStyle(locale: locale, timeZone: utc).month(.wide)).localizedCapitalized
    }

    /// The label of a bar: a day (`2026-10-21`) as "21. 10." or a month (`2026-10`) as its short name and year.
    static func pointLabel(_ key: String, locale: Locale = .current) -> String {
        if let day = dayStart(key) {
            return day.formatted(Date.FormatStyle(locale: locale, timeZone: utc).day().month(.defaultDigits))
        }
        if let month = monthStart(key) {
            return month.formatted(Date.FormatStyle(locale: locale, timeZone: utc).month(.abbreviated).year(.twoDigits))
        }
        return key
    }

    // MARK: - Units
    static func usd(_ value: Double, locale: Locale = .current) -> String {
        AccountFormat.usd(value, locale: locale)
    }

    /// Millions of tokens with one decimal ("3.9 M"), or thousands below a million.
    static func tokens(_ count: Int64, locale: Locale = .current) -> String {
        let millions = Double(count) / 1_000_000
        if millions >= 1 { return millions.formatted(.number.precision(.fractionLength(1)).locale(locale)) + " M" }
        return (Double(count) / 1_000).formatted(.number.precision(.fractionLength(0)).locale(locale)) + " k"
    }

    /// Whole minutes of audio.
    static func minutes(_ seconds: Double, locale: Locale = .current) -> String {
        (seconds / 60).formatted(.number.precision(.fractionLength(0)).locale(locale))
    }

    /// A fraction as a whole percentage ("62 %").
    static func percent(_ share: Double, locale: Locale = .current) -> String {
        share.formatted(.percent.precision(.fractionLength(0)).locale(locale))
    }

    // MARK: - Private
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    private static func dayStart(_ key: String) -> Date? {
        parse(key, format: "yyyy-MM-dd")
    }

    private static func monthStart(_ key: String) -> Date? {
        parse(key, format: "yyyy-MM")
    }

    private static func parse(_ text: String, format: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = utc
        formatter.dateFormat = format
        return formatter.date(from: text)
    }
}
