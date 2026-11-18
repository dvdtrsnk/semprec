import Foundation
import SwiftUI

/// The vertical scale of one day: how tall an hour is and how a place on the screen maps to minutes of the day. The
/// shared layer snaps what the gesture reports, so this only converts between points and raw minutes. The person
/// sets the height of an hour with two fingers, between `minimumHourHeight` and `maximumHourHeight`.
struct CalendarGeometry: Equatable {

    // MARK: - Constants
    static let standardHourHeight: CGFloat = 56
    static let minimumHourHeight: CGFloat = 24
    static let maximumHourHeight: CGFloat = 200
    static let minutesPerDay = 24 * 60
    /// The width reserved for the hour labels at the leading edge of the timeline.
    static let gutter: CGFloat = 52

    // MARK: - Properties
    let hourHeight: CGFloat

    // MARK: - Init
    init(hourHeight: CGFloat = Self.standardHourHeight) {
        self.hourHeight = Self.clamped(hourHeight)
    }

    // MARK: - Conversion
    /// The vertical position of `minutes` of the day, from the top of the timeline.
    func y(minutes: Int) -> CGFloat {
        CGFloat(minutes) / 60 * hourHeight
    }

    /// The minutes of the day at the vertical `position` of the timeline, not yet snapped, kept inside the day.
    func minutes(position: CGFloat) -> Int {
        min(max(Int((position / hourHeight * 60).rounded()), 0), Self.minutesPerDay)
    }

    /// The full height of the timeline.
    var height: CGFloat { y(minutes: Self.minutesPerDay) }

    /// The height of a block from `start` to `end` (minutes), never thinner than a readable chip.
    func blockHeight(start: Int, end: Int) -> CGFloat {
        max(y(minutes: end) - y(minutes: start), 22)
    }

    /// An hour height inside the range the pinch allows.
    static func clamped(_ hourHeight: CGFloat) -> CGFloat {
        min(max(hourHeight, minimumHourHeight), maximumHourHeight)
    }

    /// The identity of the hour line `hour` (0 to 24), which the day view scrolls to.
    static func hourId(_ hour: Int) -> String { "hour-\(hour)" }
}
