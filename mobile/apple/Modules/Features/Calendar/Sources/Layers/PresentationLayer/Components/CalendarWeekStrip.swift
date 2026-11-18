import SwiftUI

/// The weeks as pages, Monday first, on the week of the selected day. A swipe moves the weeks with the finger;
/// when it lifts past half the strip, or after a short fast flick, the strip turns to the neighbouring week, never
/// further, and shows the same weekday there. A tap shows that day. The selected day's circle fades from the old
/// day to the new one.
struct CalendarWeekStrip: View {

    // MARK: - Dependencies
    let selectedDay: String
    let today: String
    let onPick: (String) -> Void
    let onPage: (Int) -> Void

    // MARK: - Body
    var body: some View {
        CalendarPager(
            current: CalendarDates.monday(of: selectedDay),
            neighbour: { CalendarDates.shifted($0, by: $1 * 7) },
            isEnabled: true,
            onTurn: { onPage($0 * 7) },
            page: week
        )
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Subviews
private extension CalendarWeekStrip {

    func week(_ monday: String) -> some View {
        HStack(spacing: 0) {
            ForEach((0..<7).map { CalendarDates.shifted(monday, by: $0) }, id: \.self) { day in
                VStack(spacing: 4) {
                    Text(CalendarDates.weekdayShort(CalendarDates.isoWeekday(day)))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Button { onPick(day) } label: {
                        Text("\(CalendarDates.dayNumber(day))")
                            .font(.callout.weight(day == selectedDay || day == today ? .semibold : .regular))
                            .foregroundStyle(numberStyle(day))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(circleColor(day)))
                            .reportsZoomFrame(CalendarStripDayFrameKey.self, if: day == selectedDay)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(CalendarDates.dayTitle(day))
                    .accessibilityIdentifier(CalendarIdentifiers.day(day))
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 8)
        .animation(.easeInOut(duration: Self.duration), value: selectedDay)
    }
}

// MARK: - Private
private extension CalendarWeekStrip {

    static let duration = 0.25

    func numberStyle(_ day: String) -> AnyShapeStyle {
        // Today's red circle always carries white digits; another selected day inverts the text colour.
        if day == selectedDay { return day == today ? AnyShapeStyle(Color.white) : AnyShapeStyle(.background) }
        if day == today { return AnyShapeStyle(Color.red) }
        return CalendarDates.isoWeekday(day) >= 6 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }

    func circleColor(_ day: String) -> Color {
        guard day == selectedDay else { return .clear }
        return day == today ? .red : .primary
    }
}
