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
