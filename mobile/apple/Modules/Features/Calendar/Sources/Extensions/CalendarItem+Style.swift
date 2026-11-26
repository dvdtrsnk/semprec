import CoreKit
import SwiftUI

// MARK: - Style
extension CalendarItem {

    /// The colour of the item's calendar.
    var tint: Color {
        Color(hex: color) ?? .accentColor
    }

    /// Whether the item is a task, which has a checkbox instead of a time block's bar.
    var isTask: Bool { kind == .task }

    /// Whether a person can tick the item off: a task that is not a read-only trace.
    var canToggle: Bool { kind == .task && editable }

    /// The title as one line, as the system Calendar shows it: a line break in a stored title reads as a space.
    var displayTitle: String {
        title.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    /// The identity of the item on one day: a multi-day event is drawn on every day it spans.
    var identity: String { "\(id)@\(date)" }

    /// Whether the item is only a mark of a day that is over: a trace of a carried-over task, or a missed task.
    var isGhost: Bool { kind == .trace || missed }
}

// MARK: - Description
extension CalendarItem {

    /// The time of a timed item, `10:00–11:30`, or just the start when it has no end of its own.
    @MainActor var timeText: String? {
        guard let startMinutes, let endMinutes else { return nil }
        if hasEnd { return CalendarDates.range(from: startMinutes, to: endMinutes) }
        return CalendarDates.clock(minutes: startMinutes)
    }
}

// MARK: - Carried
extension CalendarItem {

    /// The same item drawn on another day, alone in its column, as it is while a finger carries it there.
    func alone(on day: String) -> CalendarItem {
        CalendarItem(
            id: id, kind: kind, title: title, color: color, date: day, endDate: nil, allDay: false,
            startMinutes: startMinutes, endMinutes: endMinutes, hasEnd: hasEnd, done: done, missed: missed,
            place: place, tentative: tentative, editable: editable, column: 0, columns: 1, depth: 0, tasks: tasks,
            hostEventTitle: hostEventTitle, carriedFrom: carriedFrom, trace: trace, traceNote: traceNote,
            timeFrom: timeFrom, timeTo: timeTo
        )
    }
}
