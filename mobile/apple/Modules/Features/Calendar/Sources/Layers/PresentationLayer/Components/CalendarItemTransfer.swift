import CoreKit
import Foundation
import SwiftUI

/// An event or a task as a drag carries it, as the system Calendar's events travel: within Semprec, and to another
/// Semprec window, by its id; to other apps as an iCalendar file (an event, or a to-do for a task) and as plain text,
/// whichever the app that takes it reads. Times are minutes of the day in `timezone`, the zone of the server.
struct CalendarItemTransfer: Codable, Transferable {

    // MARK: - Constants
    /// The type of the drag's own representation, declared by the app; read only by Semprec.
    static let typeIdentifier = "cz.semprec.calendar-item"

    // MARK: - Properties
    let id: String
    let isTask: Bool
    let title: String
    let date: String
    let endDate: String?
    let timeFrom: Int?
    let timeTo: Int?
    let place: String?
    let done: Bool
    let timezone: String

    // MARK: - Transferable
    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .init(exportedAs: typeIdentifier))
        DataRepresentation(exportedContentType: .calendarEvent) { Data($0.iCalendar.utf8) }
            .suggestedFileName { "\($0.fileTitle).ics" }
        ProxyRepresentation(exporting: \.text)
    }
}

// MARK: - Init
extension CalendarItemTransfer {

    init(_ item: CalendarItem, timezone: String) {
        self.init(
            id: item.id,
            isTask: item.isTask,
            title: item.title,
            date: item.date,
            endDate: item.endDate,
            timeFrom: item.timeFrom,
            timeTo: item.timeTo,
            place: item.place,
            done: item.done,
            timezone: timezone
        )
    }
}

// MARK: - Plain text
extension CalendarItemTransfer {

    /// The title, when it is, and where: what a message or a note shows of the item.
    var text: String {
        [title, when, place, taskState].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: "\n")
    }

    /// What a task says of itself: that it is a task, and done or still to do. `nil` for an event.
    var taskState: String? {
        guard isTask else { return nil }
        return String(localized: done ? "calendar.transfer.task.done" : "calendar.transfer.task.open", bundle: .module)
    }

    /// The day or days with the times, in the reader's language: "Tuesday 8 December 2026, 11:30–12:30".
    var when: String? {
        guard let first = instant(on: date, at: timeFrom ?? 0) else { return nil }
        let lastDay = endDate ?? date
        let formatter = DateIntervalFormatter()
        formatter.timeZone = zone
        formatter.dateStyle = .full
        guard let timeFrom else {
            formatter.timeStyle = .none
            let last = instant(on: lastDay, at: 0) ?? first
            let days = formatter.string(from: first, to: max(first, last))
            let format = String(localized: "calendar.transfer.allDay", bundle: .module)
            return String(format: format, locale: .current, days)
        }
        formatter.timeStyle = .short
        guard let timeTo, let last = instant(on: lastDay, at: timeTo), last > first else {
            let single = DateFormatter()
            single.timeZone = zone
            single.dateStyle = .full
            single.timeStyle = .short
            return single.string(from: first)
        }
        return formatter.string(from: first, to: last)
    }

    /// The title as a file name: without the characters a file system or a share sheet refuses.
    var fileTitle: String {
        let refused = CharacterSet(charactersIn: "/\\:?*\"<>|\n\r\t")
        let cleaned = title.components(separatedBy: refused).joined(separator: " ")
        let trimmed = cleaned.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? String(localized: "calendar.transfer.untitled", bundle: .module) : trimmed
    }
}

// MARK: - iCalendar
extension CalendarItemTransfer {

    /// The item as an iCalendar object (RFC 5545) the system Calendar and other calendars open: always an event, a task
    /// too (calendars leave a to-do out, and Reminders takes no iCalendar), described as a task with its state. Times
    /// are in UTC so any calendar reads them in its own zone; lines are folded at 75 octets and ended with CRLF.
    var iCalendar: String {
        var lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Semprec//Calendar//EN",
            "CALSCALE:GREGORIAN",
            "BEGIN:VEVENT",
            "UID:\(id)@semprec",
            "DTSTAMP:\(Self.utc(Date()))",
            "SUMMARY:\(Self.escaped(title))"
        ]
        lines += schedule
        if let place, !place.isEmpty { lines.append("LOCATION:\(Self.escaped(place))") }
        if let taskState {
            lines.append("DESCRIPTION:\(Self.escaped(taskState))")
            lines.append("CATEGORIES:\(Self.escaped(String(localized: "calendar.transfer.task", bundle: .module)))")
            lines.append("TRANSP:TRANSPARENT")
        }
        lines.append("END:VEVENT")
        lines.append("END:VCALENDAR")
        return lines.map(Self.folded).joined(separator: "\r\n") + "\r\n"
    }

    /// The start and the end: dates for an item without a time (the end the day after its last, as iCalendar counts
    /// it), instants otherwise. A task without an end of its own lasts the quarter of an hour the timeline draws it.
    private var schedule: [String] {
        guard let timeFrom else {
            guard let first = Self.compact(date) else { return [] }
            var lines = ["DTSTART;VALUE=DATE:\(first)"]
            if let after = Self.dayAfter(endDate ?? date) {
                lines.append("DTEND;VALUE=DATE:\(after)")
            }
            return lines
        }
        guard let start = instant(on: date, at: timeFrom) else { return [] }
        var lines = ["DTSTART:\(Self.utc(start))"]
        if let timeTo, let end = instant(on: endDate ?? date, at: timeTo), end > start {
            lines.append("DTEND:\(Self.utc(end))")
        } else {
            lines.append("DTEND:\(Self.utc(start.addingTimeInterval(Self.taskLength)))")
        }
        return lines
    }

    /// How long a task without an end is, in seconds.
    private static var taskLength: TimeInterval { 15 * 60 }

    private static func utc(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(
            format: "%04d%02d%02dT%02d%02d%02dZ",
            parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0
        )
    }

    /// The day after `day` (`YYYY-MM-DD`), as iCalendar writes a date.
    private static func dayAfter(_ day: String) -> String? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        guard let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
            let next = calendar.date(byAdding: .day, value: 1, to: date) else { return nil }
        let after = calendar.dateComponents([.year, .month, .day], from: next)
        return String(format: "%04d%02d%02d", after.year ?? 0, after.month ?? 0, after.day ?? 0)
    }

    /// `YYYY-MM-DD` as iCalendar writes a date, `YYYYMMDD`.
    private static func compact(_ day: String) -> String? {
        let digits = day.replacingOccurrences(of: "-", with: "")
        let isDate = digits.count == 8 && digits.allSatisfy(\.isNumber)
        return isDate ? digits : nil
    }

    /// A text value with the characters iCalendar gives a meaning escaped.
    private static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: ";", with: "\\;")
            .replacingOccurrences(of: ",", with: "\\,")
            .replacingOccurrences(of: "\r\n", with: "\\n")
            .replacingOccurrences(of: "\n", with: "\\n")
    }

    /// A content line folded so no line is longer than 75 octets, never inside a character.
    private static func folded(_ line: String) -> String {
        var result = ""
        var length = 0
        for character in line {
            let size = String(character).utf8.count
            if length + size > 75 {
                result += "\r\n "
                length = 1
            }
            result.append(character)
            length += size
        }
        return result
    }
}

// MARK: - Dates
private extension CalendarItemTransfer {

    var zone: TimeZone { TimeZone(identifier: timezone) ?? .current }

    /// The instant `minutes` after the midnight of `day` (`YYYY-MM-DD`) in the server's zone.
    func instant(on day: String, at minutes: Int) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let midnight = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        return midnight.flatMap { calendar.date(byAdding: .minute, value: minutes, to: $0) }
    }
}
