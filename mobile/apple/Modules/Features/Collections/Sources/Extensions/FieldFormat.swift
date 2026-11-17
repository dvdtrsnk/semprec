import CoreKit
import Foundation

/// Turns the typed values of an item into the short text a row or a field shows. Dates follow the design principles:
/// today, tomorrow and yesterday by name, anything else as weekday, day and month.
struct FieldFormat {

    // MARK: - Dependencies
    private let calendar: Calendar
    private let locale: Locale
    private let now: Date

    // MARK: - Init
    init(calendar: Calendar = .current, locale: Locale = .current, now: Date = Date()) {
        self.calendar = calendar
        self.locale = locale
        self.now = now
    }

    // MARK: - Dates
    /// The day an ISO date or date-time starts with, at noon in the calendar's time zone; nil when it is not one.
    func date(fromISO iso: String) -> Date? {
        let day = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard day.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: day[0], month: day[1], day: day[2], hour: 12))
    }

    /// The ISO day of `date`, `YYYY-MM-DD`.
    func iso(from date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "Today", "Tomorrow", "Yesterday", else "Thu 22. 10." in the person's language; the ISO text when unreadable.
    func day(_ iso: String) -> String {
        guard let date = date(fromISO: iso) else { return iso }
        switch daysFromToday(date) {
        case 0: return relative("date.today")
        case 1: return relative("date.tomorrow")
        case -1: return relative("date.yesterday")
        default: break
        }
        return formatted(date, template: calendar.isDate(date, equalTo: now, toGranularity: .year) ? "EEEdM" : "EEEdMy")
    }

    func isToday(_ iso: String) -> Bool {
        date(fromISO: iso).map { daysFromToday($0) == 0 } ?? false
    }

    /// The whole date, "16. 10. 2026".
    func fullDay(_ iso: String) -> String {
        date(fromISO: iso).map { formatted($0, template: "yMd") } ?? iso
    }

    /// "October 2026".
    func month(_ iso: String) -> String {
        guard let date = date(fromISO: "\(iso)-01") else { return iso }
        return formatted(date, template: "LLLLy")
    }

    /// A time of day as the person's clock shows it.
    func time(_ text: String) -> String {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        let clock = DateComponents(year: 2000, month: 1, day: 1, hour: parts.first, minute: parts.dropFirst().first)
        guard parts.count >= 2, let date = calendar.date(from: clock) else { return text }
        return formatted(date, template: "jm")
    }

    // MARK: - Content
    /// The short text of `content` for a subtitle or a field; nil when there is nothing to show.
    func text(for content: FieldContent) -> String? {
        switch content {
        case .empty: nil
        case .text(let text), .link(let text): text
        case .number(let number): number.formatted(.number.locale(locale))
        case .flag(let isOn): isOn ? String(localized: "field.flag.on", bundle: .module) : nil
        case .day(let iso): day(iso)
        case .clock(let time): self.time(time)
        case .choices(let options): options.map(\.label).joined(separator: ", ")
        case .targets(let targets): targets.map(\.title).joined(separator: ", ")
        case .blob(_, let filename, _, _): filename
        }
    }

    /// The pieces of a row's subtitle joined by a middle dot.
    func subtitle(_ contents: [FieldContent]) -> String {
        contents.compactMap(text).joined(separator: " · ")
    }

    func fileSize(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

// MARK: - Private
private extension FieldFormat {

    /// How many calendar days `date` is from today; negative for the past.
    func daysFromToday(_ date: Date) -> Int? {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day
    }

    func relative(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }

    func formatted(_ date: Date, template: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}
