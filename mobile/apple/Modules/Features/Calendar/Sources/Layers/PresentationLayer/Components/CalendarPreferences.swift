import SwiftUI

/// Where each event block is in the day view's space, so a task held over one can be put into it.
struct CalendarEventFramesKey: PreferenceKey {

    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Where each item is drawn in the day view's space, by id: what a drag that lifts at a place lifted.
struct CalendarItemFramesKey: PreferenceKey {

    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Where the selected block is in the day view's space, which the menu of its actions is placed beside.
struct CalendarSelectedFrameKey: PreferenceKey {

    static let defaultValue: CGRect? = nil

    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        value = nextValue() ?? value
    }
}

/// Reports the frame of the block that is selected, which the menu of its actions is placed by.
struct SelectedFrameReporter: View {

    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(key: CalendarSelectedFrameKey.self, value: proxy.frame(in: .calendarDay))
        }
    }
}

/// Reports the frame of an item under its id, and of an event block also among the events a task can be put into.
struct CalendarItemFrameReporter: View {

    let id: String
    let isEvent: Bool

    var body: some View {
        GeometryReader { proxy in
            let frame = proxy.frame(in: .calendarDay)
            Color.clear
                .preference(key: CalendarItemFramesKey.self, value: [id: frame])
                .preference(key: CalendarEventFramesKey.self, value: isEvent ? [id: frame] : [:])
        }
    }
}
