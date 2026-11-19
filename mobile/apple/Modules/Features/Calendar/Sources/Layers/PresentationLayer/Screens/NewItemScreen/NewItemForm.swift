import CoreKit
import Foundation

/// What the new item form holds while the person types: native view state that becomes a `NewItemDraft` when the
/// form is submitted. Times are minutes of the day. An event always ends; `endDay` is its last day, `day` itself
/// unless it lasts several days. A task has a day and maybe a time, no end.
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
    var endDay: String
    var place = ""
    /// Empty for the default calendar.
    var calendarId = ""
    var notes = ""
    var url = ""
    /// Minutes before the start an event alerts, `nil` for no alert.
    var alertMinutes: Int?
    /// Minutes of travel before an event, `nil` for none.
    var travelMinutes: Int?
    var repeatRule: NewItemRepeat = .never
    var flagged = false

    // MARK: - Init
    /// A form for `day` that starts at the next full hour after `now` and lasts an hour.
    init(day: String, now: Date = Date(), calendar: Calendar = .current) {
        self.day = day
        endDay = day
        let parts = calendar.dateComponents([.hour], from: now)
        startMinutes = min(((parts.hour ?? 0) + 1) * Self.hour, Self.latestDefaultStart)
        endMinutes = startMinutes + Self.hour
    }

    // MARK: - Methods
    /// A title, and for a timed event an end after its start.
    var canSubmit: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !endsBeforeStart
    }

    /// Whether a timed event's end comes before or at its start, which the form shows struck through.
    var endsBeforeStart: Bool {
        guard kind == .event else { return false }
        if endDay != day { return endDay < day }
        return timed && endMinutes <= startMinutes
    }

    /// The values handed to the shared ViewModel. A task has no end, place, calendar, link, alert or travel time; an
    /// event without a time has no end time either.
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
            calendarId: isEvent ? calendarId : "",
            endDay: isEvent && endDay != day ? endDay : "",
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines),
            url: isEvent ? url.trimmingCharacters(in: .whitespacesAndNewlines) : "",
            alertMinutes: isEvent ? alertMinutes : nil,
            travelMinutes: isEvent ? travelMinutes : nil,
            repeatRule: repeatRule,
            flagged: !isEvent && flagged
        )
    }

    /// Moves the start and keeps the duration, so the end follows; the end stops at the last time of the day.
    mutating func moveStart(to minutes: Int) {
        let duration = max(endMinutes - startMinutes, Self.hour)
        startMinutes = minutes
        endMinutes = min(minutes + duration, Self.latestEnd)
    }

    /// Moves the first day and keeps the length, so the last day follows.
    mutating func moveDay(to newDay: String, calendar: Calendar = .current) {
        let length = Self.days(from: day, to: endDay, calendar: calendar)
        day = newDay
        let first = Self.date(ofDay: newDay, calendar: calendar)
        let last = calendar.date(byAdding: .day, value: max(length, 0), to: first)
        endDay = last.map { Self.day(of: $0, calendar: calendar) } ?? newDay
    }

    /// A repeat an event cannot keep, every year, becomes no repeat when a task becomes an event.
    mutating func fitRepeatToKind() {
        if kind == .event, !NewItemOptions.eventRepeats.contains(repeatRule) { repeatRule = .never }
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

    /// How many days `end` is after `start`.
    static func days(from start: String, to end: String, calendar: Calendar = .current) -> Int {
        let first = date(ofDay: start, calendar: calendar)
        let last = date(ofDay: end, calendar: calendar)
        return calendar.dateComponents([.day], from: first, to: last).day ?? 0
    }

    /// The minutes after local midnight of `date`.
    static func minutes(of date: Date, calendar: Calendar = .current) -> Int {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * hour + (parts.minute ?? 0)
    }
}
