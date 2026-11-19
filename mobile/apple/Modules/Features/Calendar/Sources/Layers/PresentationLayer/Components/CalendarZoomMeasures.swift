import SwiftUI

/// Where the places a change of zoom moves between were last laid out, in the calendar's zoom space: the selected
/// day's digits in the day's week strip and in the month's grid, the month's row of that day, and the small months
/// of the selected year. The views write them as they are laid out, outside SwiftUI's state, and a change of zoom
/// reads them when it begins.
@MainActor
final class CalendarZoomMeasures {

    // MARK: - Properties
    var stripDay: CGRect?
    var monthDay: CGRect?
    var monthRow: CGRect?
    /// Which week of its month `monthRow` is.
    var monthRowIndex = 0
    var monthFrames: [Int: CGRect] = [:]
}

// MARK: - Measuring
extension View {

    /// Hands this view's frame in the calendar's zoom space to `report` whenever it changes, when `isMeasured`. Only
    /// the measured view observes its geometry; the others carry nothing.
    func measuresZoomFrame(if isMeasured: Bool, _ report: @escaping (CGRect) -> Void) -> some View {
        background {
            if isMeasured {
                Color.clear.onGeometryChange(
                    for: CGRect.self,
                    of: { $0.frame(in: .named(CalendarZoomTransition.space)) },
                    action: report
                )
            }
        }
    }
}

// MARK: - Environment
extension EnvironmentValues {

    /// Where the calendar's views write the places a change of zoom moves between.
    @Entry var calendarZoomMeasures = CalendarZoomMeasures?.none
}
