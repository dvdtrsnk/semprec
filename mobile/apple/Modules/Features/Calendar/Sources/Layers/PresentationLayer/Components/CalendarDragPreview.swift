import CoreKit
import SwiftUI

/// The card of an item's drag: a small card with its colour, title and time, as the system Calendar's drag shows away
/// from its timeline, on the rest of the screen and in other apps.
struct CalendarDragPreview: View {

    // MARK: - Dependencies
    let item: CalendarItem

    // MARK: - Body
    var body: some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(item.tint)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.displayTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(when)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: 160, alignment: .leading)
        .background(item.tint.opacity(0.18), in: RoundedRectangle(cornerRadius: 6))
        .background(.background, in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Subviews
private extension CalendarDragPreview {

    /// The times of a timed item, or that it is for the whole day.
    var when: String {
        guard let start = item.timeFrom ?? item.startMinutes else {
            return String(localized: "calendar.allDay", bundle: .module)
        }
        guard let end = item.timeTo, item.hasEnd || item.kind == .event else {
            return CalendarDates.clock(minutes: start)
        }
        return "\(CalendarDates.clock(minutes: start))–\(CalendarDates.clock(minutes: end))"
    }
}
