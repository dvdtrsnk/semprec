import Foundation
import SwiftUI

/// The vertical scale of one day: how tall an hour is and how a place on the screen maps to minutes of the day. The
/// shared layer snaps what the gesture reports, so this only converts between points and raw minutes.
struct CalendarGeometry: Equatable {

    // MARK: - Constants
    static let hourHeight: CGFloat = 56
    static let minutesPerDay = 24 * 60
    /// The width reserved for the hour labels at the leading edge of the timeline.
    static let gutter: CGFloat = 52

    // MARK: - Conversion
    /// The vertical position of `minutes` of the day, from the top of the timeline.
    static func y(minutes: Int) -> CGFloat {
        CGFloat(minutes) / 60 * hourHeight
    }

    /// The minutes of the day at the vertical `position` of the timeline, not yet snapped, kept inside the day.
    static func minutes(position: CGFloat) -> Int {
        min(max(Int((position / hourHeight * 60).rounded()), 0), minutesPerDay)
    }

    /// The identity of the hour line `hour` (0 to 24), which the day view scrolls to.
    static func hourId(_ hour: Int) -> String { "hour-\(hour)" }

    /// The full height of the timeline.
    static var height: CGFloat { y(minutes: minutesPerDay) }

    /// The height of a block from `start` to `end` (minutes), never thinner than a readable chip.
    static func blockHeight(start: Int, end: Int) -> CGFloat {
        max(y(minutes: end) - y(minutes: start), 22)
    }
}
