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

/// Where each small month of the year view is, by its month 1 to 12, in the calendar's zoom space; a change between
/// the year and a month zooms on it.
struct CalendarMonthFramesKey: PreferenceKey {

    static let defaultValue: [Int: CGRect] = [:]

    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Where the selected day's digits are in the calendar's zoom space: in the day's week strip and in the month's grid.
/// A change between a day and a month moves the views by the distance between them.
struct CalendarStripDayFrameKey: PreferenceKey {

    static let defaultValue = CGRect.zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

struct CalendarMonthDayFrameKey: PreferenceKey {

    static let defaultValue = CGRect.zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// Where the month's row of the selected day is in the calendar's zoom space.
struct CalendarMonthRowFrameKey: PreferenceKey {

    static let defaultValue = CGRect.zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
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

    /// Reports this view's frame in the calendar's zoom space through `key` when `isReported`.
    func reportsZoomFrame<Key: PreferenceKey>(_ key: Key.Type, if isReported: Bool) -> some View
    where Key.Value == CGRect {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: key,
                    value: isReported ? proxy.frame(in: .named(CalendarZoomTransition.space)) : .zero
                )
            }
        )
    }
}
