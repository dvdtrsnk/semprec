import CoreKit
import DesignSystem
import SwiftUI

/// The colours of one day's timeline and nothing else: the sleep bands and the timed items as tinted shapes where the
/// timeline draws them. The header's frosted backdrop blurs it until only the colours are left, so it draws no text
/// and no gestures and costs little while the day moves.
struct CalendarTimelineColors: View {

    // MARK: - Dependencies
    let day: CalendarDayState
    let geometry: CalendarGeometry

    // MARK: - Body
    var body: some View {
        Canvas { context, size in
            let width = max(size.width - CalendarGeometry.gutter - 8, 0)
            for (start, end) in sleepRanges {
                let rect = CGRect(
                    x: CalendarGeometry.gutter,
                    y: geometry.y(minutes: start),
                    width: width,
                    height: max(geometry.y(minutes: end) - geometry.y(minutes: start), 0)
                )
                context.fill(Path(roundedRect: rect, cornerRadius: 6), with: .color(Theme.Colors.sleep.opacity(0.1)))
            }
            for item in timedItems {
                let columns = CGFloat(max(item.columns, 1))
                let columnWidth = width / columns
                let start = item.startMinutes ?? 0
                let rect = CGRect(
                    x: CalendarGeometry.gutter + CGFloat(item.column) * columnWidth,
                    y: geometry.y(minutes: start),
                    width: max(columnWidth - 2, 0),
                    height: geometry.blockHeight(start: start, end: item.endMinutes ?? start)
                )
                context.fill(Path(rect), with: .color(item.tint.opacity(item.isTask ? 0.08 : 0.16)))
                if !item.isTask {
                    let bar = CGRect(x: rect.minX, y: rect.minY, width: 4, height: rect.height)
                    context.fill(Path(bar), with: .color(item.tint))
                }
            }
        }
        .frame(height: geometry.height)
    }
}

// MARK: - Private
private extension CalendarTimelineColors {

    var timedItems: [CalendarItem] {
        day.items.filter { $0.startMinutes != nil && !$0.allDay }
    }

    /// The parts of the evening's and the morning's nights that fall on this day, as the shared layer cut them.
    var sleepRanges: [(Int, Int)] {
        [day.sleepEvening, day.sleepMorning]
            .compactMap { $0 }
            .filter { $0.toMinutes > $0.fromMinutes }
            .map { ($0.fromMinutes, $0.toMinutes) }
    }
}
