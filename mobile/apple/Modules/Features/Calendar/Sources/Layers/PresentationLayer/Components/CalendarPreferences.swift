import SwiftUI

/// Where the timeline's content is in the day view's space; it moves as the timeline scrolls, and a finger's place
/// converts to minutes of the day through it.
struct CalendarContentFrameKey: PreferenceKey {

    static let defaultValue = CGRect.zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// Where the visible part of the timeline is in the day view's space.
struct CalendarViewportFrameKey: PreferenceKey {

    static let defaultValue = CGRect.zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// Where each event block is in the day view's space, so a task held over one can be put into it.
struct CalendarEventFramesKey: PreferenceKey {

    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

// MARK: - Frame reporting
extension View {

    /// Reports this view's frame in the day view's space through `key`.
    func reportsFrame<Key: PreferenceKey>(_ key: Key.Type) -> some View where Key.Value == CGRect {
        background(
            GeometryReader { proxy in
                Color.clear.preference(key: key, value: proxy.frame(in: .calendarDay))
            }
        )
    }
}
