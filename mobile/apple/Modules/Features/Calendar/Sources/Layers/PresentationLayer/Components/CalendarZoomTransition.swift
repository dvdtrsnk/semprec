import CoreKit
import SwiftUI

/// How the calendar moves between a year, a month and a day, as the system Calendar does. Between a year and a
/// month the view zooms on the place of the month in the year's grid: the month shrinks into its small month and
/// the year opens out of it, or the other way round. Between a month and a day both views move by the distance
/// between the selected day in the month's grid and in the day's week strip, so the week's row slides between the
/// two places; the month's other rows and the whole day fade, while the week's row stays.
struct CalendarZoomTransition: Equatable {

    // MARK: - Properties
    let source: CalendarZoom
    let target: CalendarZoom
    /// The month the change is about, 1 to 12; it places the zoom between a year and a month.
    let month: Int
    /// Where that month's small month lies in the year view, when the year was laid out, and the size of the space
    /// the views fill; without them the zoom falls back on the grid's proportions.
    let monthFrame: CGRect?
    let space: CGSize
    /// Where the selected day's digits are in the day's week strip and in the month's grid, when both were laid out.
    let stripDay: CGRect?
    let monthDay: CGRect?

    // MARK: - Methods
    /// The animation of a change of zoom.
    static let animation = Animation.smooth(duration: 0.42)

    /// The named space the zoom measures in.
    static let space = "calendar.zoom.space"

    /// How the view of `zoom` looks when it has come in or gone out in this change; it animates from or to what
    /// `CalendarZoomEffect.shown` of that look shows.
    func effect(for zoom: CalendarZoom) -> CalendarZoomEffect {
        if let shift = weekShift {
            return CalendarZoomEffect(
                offset: zoom == .month ? -shift : shift,
                keepsRow: zoom == .month
            )
        }
        guard isBetweenYearAndMonth else { return CalendarZoomEffect() }
        let monthScale = self.monthScale
        return CalendarZoomEffect(
            scale: zoom == .year ? 1 / monthScale : monthScale,
            anchor: anchor(scale: monthScale)
        )
    }
}

// MARK: - Private
private extension CalendarZoomTransition {

    /// A year shows three small months in a row, so a month is a third as wide there.
    static let monthsAcross: CGFloat = 3

    /// How far below the day's strip the month's row of the selected day lies, in a change between them.
    var weekShift: CGFloat? {
        guard Set([source, target]) == Set([CalendarZoom.day, CalendarZoom.month]),
              let stripDay, let monthDay else { return nil }
        return monthDay.midY - stripDay.midY
    }

    var isBetweenYearAndMonth: Bool {
        Set([source, target]) == Set([CalendarZoom.year, CalendarZoom.month])
    }

    /// How much smaller the small month is than the full month.
    var monthScale: CGFloat {
        guard let monthFrame, space.width > 0 else { return 1 / Self.monthsAcross }
        return min(max(monthFrame.width / space.width, 0.1), 0.9)
    }

    /// The point a scale by `scale` keeps in place so that the full month lands on its small month, top-left
    /// corner on top-left corner: the corner divided by what the scale takes away.
    func anchor(scale: CGFloat) -> UnitPoint {
        guard let monthFrame, space.width > 0, space.height > 0 else { return estimatedAnchor }
        return UnitPoint(
            x: monthFrame.minX / (1 - scale) / space.width,
            y: monthFrame.minY / (1 - scale) / space.height
        )
    }

    /// Where the month sits in the year's grid of three columns and four rows, below the year's title.
    var estimatedAnchor: UnitPoint {
        let index = max(min(month, 12), 1) - 1
        let column = CGFloat(index % 3)
        let row = CGFloat(index / 3)
        let titleShare: CGFloat = 0.1
        return UnitPoint(x: (column + 0.5) / 3, y: titleShare + (row + 0.5) / 4 * (1 - titleShare))
    }
}
