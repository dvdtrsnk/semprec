import CoreKit
import Foundation

/// How tasks and events write their days, times and lengths (Principles, "Čas a termíny"): relative words for
/// yesterday, today and tomorrow, otherwise the weekday and the day; start and end as `14:00–15:30`. Values arrive as
/// `yyyy-MM-dd` and `HH:mm`; the words and the order of the date follow the locale.
enum WorkFormatting {

    // MARK: - Days
    /// "Dnes", "Zítra" or "Včera" for those days, nil for any other day (or text that is no day).
    static func relativeWord(_ day: String, today: String, calendar: Calendar = .current) -> String? {
        switch distance(from: today, to: day, calendar: calendar) {
        case -1: String(localized: "day.yesterday", bundle: .module)
        case 0: String(localized: "day.today", bundle: .module)
        case 1: String(localized: "day.tomorrow", bundle: .module)
        default: nil
        }
    }

    /// The word for yesterday, today or tomorrow, otherwise the weekday and the day (`čt 22. 10.`).
    static func dayLabel(
        _ day: String,
        today: String,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        if let word = relativeWord(day, today: today, calendar: calendar) { return word }
        return compactDay(day, calendar: calendar, locale: locale)
    }

    /// The weekday and the day without a relative word (`čt 22. 10.`), or `day` itself when it is no day.
    static func compactDay(_ day: String, calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard let date = date(day, calendar: calendar) else { return day }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.defaultDigits).locale(locale))
    }

    /// The day as the Datum row of the sheet writes it: `Dnes, pátek 16. 10.`, or `Pátek 16. 10.`.
    static func longDayLabel(
        _ day: String,
        today: String,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard let date = date(day, calendar: calendar) else { return day }
        let long = date.formatted(.dateTime.weekday(.wide).day().month(.defaultDigits).locale(locale))
        if let word = relativeWord(day, today: today, calendar: calendar) {
            return String(format: String(localized: "day.relativeLong", bundle: .module), locale: locale, word, long)
        }
        return long.prefix(1).uppercased(with: locale) + long.dropFirst()
    }

    // MARK: - Times
    /// `14:00–15:30`, `14:00` for a start alone, nil without a start.
    static func timeRange(from start: String?, to end: String?) -> String? {
        guard let start else { return nil }
        guard let end else { return clock(start) }
        return "\(clock(start))–\(clock(end))"
    }

    /// `9:00` for `09:00`: the way the boards write a time.
    static func clock(_ time: String) -> String {
        guard time.hasPrefix("0"), time.count == 5 else { return time }
        return String(time.dropFirst())
    }

    /// `1 h 30 min` for 90 minutes, in the language of the locale.
    static func length(minutes: Int, locale: Locale = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        let formatter = DateComponentsFormatter()
        formatter.calendar = calendar
        formatter.allowedUnits = [.hour, .minute]
        formatter.unitsStyle = .abbreviated
        return formatter.string(from: TimeInterval(minutes * 60)) ?? "\(minutes)"
    }

    // MARK: - Rows
    /// The line under a task's title: where it was moved from, or when it is, then its project and how it repeats.
    /// The group already says today or tomorrow, so those days are left out of it.
    static func meta(
        for row: TaskRow,
        in group: TaskSectionKind,
        today: String,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        var parts: [String] = []
        if let moved = row.movedFrom {
            parts.append(movedText(from: moved, today: today, calendar: calendar, locale: locale))
        } else {
            parts.append(contentsOf: whenParts(of: row, in: group, today: today, calendar: calendar, locale: locale))
        }
        if let project = row.projectTitle { parts.append(project) }
        if row.repeats != .never { parts.append("↻ " + repeatTitle(row.repeats).lowercased(with: locale)) }
        return parts.joined(separator: " · ")
    }

    /// "přesunuto ze včerejška" or "přesunuto z 13. 10.".
    static func movedText(from day: String, today: String, calendar: Calendar, locale: Locale) -> String {
        if distance(from: today, to: day, calendar: calendar) == -1 {
            return String(localized: "task.movedFromYesterday", bundle: .module)
        }
        let compact = compactDay(day, calendar: calendar, locale: locale)
        return String(format: String(localized: "task.movedFrom", bundle: .module), locale: locale, compact)
    }

    private static func whenParts(
        of row: TaskRow,
        in group: TaskSectionKind,
        today: String,
        calendar: Calendar,
        locale: Locale
    ) -> [String] {
        var parts: [String] = []
        let groupSaysTheDay = group == .today || group == .tomorrow
        if let date = row.date, !groupSaysTheDay {
            parts.append(dayLabel(date, today: today, calendar: calendar, locale: locale))
        }
        if let range = timeRange(from: row.timeFrom, to: row.timeTo) { parts.append(range) }
        return parts.isEmpty ? [] : [parts.joined(separator: " ")]
    }

    // MARK: - Repeat
    static func repeatTitle(_ repeats: TaskRepeat) -> String {
        switch repeats {
        case .never: String(localized: "repeat.never", bundle: .module)
        case .daily: String(localized: "repeat.daily", bundle: .module)
        case .weekdays: String(localized: "repeat.weekdays", bundle: .module)
        case .weekly: String(localized: "repeat.weekly", bundle: .module)
        case .monthly: String(localized: "repeat.monthly", bundle: .module)
        case .custom: String(localized: "repeat.custom", bundle: .module)
        }
    }

    // MARK: - Dates
    private static func date(_ day: String, calendar: Calendar) -> Date? {
        let numbers = day.split(separator: "-").compactMap { Int($0) }
        guard numbers.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: numbers[0], month: numbers[1], day: numbers[2]))
    }

    /// The days from `today` to `day`: positive when `day` is later; nil when either is no day.
    static func distance(from today: String, to day: String, calendar: Calendar) -> Int? {
        guard let start = date(today, calendar: calendar), let end = date(day, calendar: calendar) else { return nil }
        return calendar.dateComponents([.day], from: start, to: end).day
    }
}
