import Foundation

/// How the sleep screens write times, durations, weekdays and nights.
enum SleepFormat {

    // MARK: - Times
    /// A time of day from minutes after midnight: `6:45`, `23:00`.
    static func time(_ minutes: Int) -> String {
        let wrapped = ((minutes % 1_440) + 1_440) % 1_440
        return String(format: "%d:%02d", wrapped / 60, wrapped % 60)
    }

    /// A length of time: `45 min`, `8 h`, `7 h 45 min`.
    static func duration(_ minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 {
            return String(format: String(localized: "sleep.duration.minutes", bundle: .module), locale: .current, rest)
        }
        if rest == 0 {
            return String(format: String(localized: "sleep.duration.hours", bundle: .module), locale: .current, hours)
        }
        return String(
            format: String(localized: "sleep.duration.both", bundle: .module),
            locale: .current,
            hours,
            rest
        )
    }

    /// A length as the schedule editor writes it: `45 min`, `8 hod`, `7 hod 30 min`.
    static func longDuration(_ minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 {
            return String(format: String(localized: "sleep.duration.minutes", bundle: .module), locale: .current, rest)
        }
        if rest == 0 {
            return String(
                format: String(localized: "sleep.duration.long.hours", bundle: .module),
                locale: .current,
                hours
            )
        }
        return String(
            format: String(localized: "sleep.duration.long.both", bundle: .module),
            locale: .current,
            hours,
            rest
        )
    }

    /// A reminder lead: `30 min before bedtime`, `1 h before bedtime`.
    static func lead(_ minutes: Int) -> String {
        if minutes == 60 {
            return String(localized: "sleep.remind.hour", bundle: .module)
        }
        return String(format: String(localized: "sleep.remind.minutes", bundle: .module), locale: .current, minutes)
    }

    /// How a night compares with the goal: `exactly the goal`, `+30 min over the goal`, `15 min under the goal`.
    static func goalDifference(_ minutes: Int) -> String {
        if minutes == 0 {
            return String(localized: "sleep.ring.goal.exact", bundle: .module)
        }
        let key: String.LocalizationValue = minutes > 0 ? "sleep.ring.goal.above" : "sleep.ring.goal.below"
        return String(format: String(localized: key, bundle: .module), locale: .current, duration(abs(minutes)))
    }

    // MARK: - Weekdays
    /// `Mon`, `Po`: the short name of an ISO weekday, 1 for Monday up to 7 for Sunday.
    static func weekdayShort(_ isoDay: Int) -> String {
        symbol(isoDay, from: calendar.shortStandaloneWeekdaySymbols).localizedCapitalized
    }

    /// `P`, `Ú`, `M`: the one-letter name of an ISO weekday, as the days picker shows it.
    static func weekdayInitial(_ isoDay: Int) -> String {
        symbol(isoDay, from: calendar.veryShortStandaloneWeekdaySymbols).localizedUppercase
    }

    static func weekdayLong(_ isoDay: Int) -> String {
        symbol(isoDay, from: calendar.standaloneWeekdaySymbols)
    }

    /// The days of a plan: `Mon–Fri`, `Sat, Sun`, `Every day`, or the short names in order.
    static func days(_ isoDays: [Int]) -> String {
        let sorted = isoDays.sorted()
        switch sorted {
        case [1, 2, 3, 4, 5]: return String(localized: "sleep.days.weekdays", bundle: .module)
        case [6, 7]: return String(localized: "sleep.days.weekend", bundle: .module)
        case Array(1...7): return String(localized: "sleep.days.everyDay", bundle: .module)
        default: return sorted.map(weekdayShort).formatted(.list(type: .and, width: .narrow))
        }
    }

    // MARK: - Nights
    /// The date of a night's evening, `YYYY-MM-DD`; nil for anything else.
    static func date(of night: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: night)
    }

    /// `Fri 16 → Sat 17`: the evening and the morning of a night.
    static func range(of night: String) -> String? {
        guard let evening = date(of: night), let morning = calendar.date(byAdding: .day, value: 1, to: evening) else {
            return nil
        }
        let day = Date.FormatStyle(locale: .current, calendar: calendar).weekday(.abbreviated).day()
        return "\(evening.formatted(day)) → \(morning.formatted(day))"
    }

    // MARK: - Private
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = .current
        return calendar
    }

    private static func symbol(_ isoDay: Int, from symbols: [String]) -> String {
        symbols.indices.contains(isoDay % 7) ? symbols[isoDay % 7] : ""
    }
}
