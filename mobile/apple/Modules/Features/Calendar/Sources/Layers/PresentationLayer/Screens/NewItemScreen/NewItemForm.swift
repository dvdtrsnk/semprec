import CoreKit
import Foundation

/// What the new item form holds while the person types: native view state that becomes a `NewItemDraft` when the
/// form is submitted. Times are minutes of the day.
struct NewItemForm: Equatable {

    // MARK: - Constants
    static let hour = 60
    /// The latest default start, so that a default end of an hour later stays on the same day.
    static let latestDefaultStart = 22 * hour
    /// The latest end a time picker shows.
    static let latestEnd = 23 * hour + 55

    // MARK: - Properties
    var kind: NewItemKind = .event
    var title = ""
    var day: String
    var timed = true
    var startMinutes: Int
    var hasEnd = true
    var endMinutes: Int
    var place = ""
    /// Empty for the default calendar.
    var calendarId = ""

    // MARK: - Init
    /// A form for `day` that starts at the next full hour after `now` and lasts an hour.
    init(day: String, now: Date = Date(), calendar: Calendar = .current) {
        self.day = day
        let parts = calendar.dateComponents([.hour], from: now)
        startMinutes = min(((parts.hour ?? 0) + 1) * Self.hour, Self.latestDefaultStart)
        endMinutes = startMinutes + Self.hour
    }

    // MARK: - Methods
    /// A title is the one value the form needs before it can be submitted.
    var canSubmit: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The values handed to the shared ViewModel. A task has no end, place or calendar; an event without a time has
    /// no end either.
    var draft: NewItemDraft {
        let isEvent = kind == .event
        return NewItemDraft(
            kind: kind,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            day: day,
            timed: timed,
            startMinutes: startMinutes,
            hasEnd: isEvent && timed && hasEnd,
            endMinutes: endMinutes,
            place: isEvent ? place.trimmingCharacters(in: .whitespacesAndNewlines) : "",
            calendarId: isEvent ? calendarId : ""
        )
    }

    /// Moves the start and keeps the duration, so the end follows; the end stops at the last time of the day.
    mutating func moveStart(to minutes: Int) {
        let duration = max(endMinutes - startMinutes, Self.hour)
        startMinutes = minutes
        endMinutes = min(minutes + duration, Self.latestEnd)
    }
}

// MARK: - Dates
extension NewItemForm {

    /// The local midnight of `day` (`YYYY-MM-DD`) for a date picker; today for a key that is no day.
    static func date(ofDay day: String, calendar: Calendar = .current) -> Date {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
            let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        else { return calendar.startOfDay(for: Date()) }
        return date
    }

    /// The `YYYY-MM-DD` key of the local day of `date`.
    static func day(of date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// A date whose local time is `minutes` after midnight, for a time picker. It sits on a January day, which no
    /// zone shifts for daylight saving, so every time of the day exists.
    static func time(minutes: Int, calendar: Calendar = .current) -> Date {
        let components = DateComponents(year: 2001, month: 1, day: 1, hour: minutes / hour, minute: minutes % hour)
        return calendar.date(from: components) ?? Date()
    }

    /// The minutes after local midnight of `date`.
    static func minutes(of date: Date, calendar: Calendar = .current) -> Int {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * hour + (parts.minute ?? 0)
    }
}
