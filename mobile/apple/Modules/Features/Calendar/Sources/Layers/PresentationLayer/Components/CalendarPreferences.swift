import SwiftUI

/// Where each event block is in the day view's space, so a task held over one can be put into it.
struct CalendarEventFramesKey: PreferenceKey {

    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}
