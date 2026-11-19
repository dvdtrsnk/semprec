import SwiftUI

/// The days of a small month of the year view, drawn in one canvas rather than as a view per day: a year shows
/// hundreds of them and the scroll lays a new year out as it comes into view. Today is a white number on red.
struct CalendarMiniMonthGrid: View {

    // MARK: - Dependencies
    /// The day numbers by week, Monday first; a place before the 1st or after the last day is `nil`.
    let weeks: [[Int?]]
    /// Today's number when today is in this month.
    let today: Int?

    // MARK: - Body
    var body: some View {
        // Drawn off the main thread, so a year zooming in or out does not wait for its digits.
        Canvas(rendersAsynchronously: true) { context, size in
            let columnWidth = size.width / 7
            for (row, week) in weeks.enumerated() {
                for (column, day) in week.enumerated() {
                    guard let day else { continue }
                    let center = CGPoint(
                        x: (CGFloat(column) + 0.5) * columnWidth,
                        y: CGFloat(row) * (Self.rowHeight + Self.rowSpacing) + Self.rowHeight / 2
                    )
                    let isToday = day == today
                    if isToday {
                        let circle = CGRect(x: center.x - 6.5, y: center.y - 6.5, width: 13, height: 13)
                        context.fill(Path(ellipseIn: circle), with: .color(.red))
                    }
                    let number = Text(verbatim: "\(day)")
                        .font(.system(size: 8.5, weight: isToday ? .bold : .medium))
                        .foregroundStyle(isToday ? Color.white : Color.primary)
                    context.draw(context.resolve(number), at: center)
                }
            }
        }
        .frame(height: CGFloat(weeks.count) * (Self.rowHeight + Self.rowSpacing) - Self.rowSpacing)
        .accessibilityHidden(true)
    }
}

// MARK: - Private
private extension CalendarMiniMonthGrid {

    static let rowHeight: CGFloat = 13
    static let rowSpacing: CGFloat = 1
}
