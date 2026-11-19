import SwiftUI

/// The weeks as pages, Monday first, on the week of the selected day. A swipe moves the weeks with the finger;
/// when it lifts past half the strip, or after a short fast flick, the strip turns to the neighbouring week, never
/// further, and shows the same weekday there. A tap shows that day. The selected day's circle shrinks away from the
/// old day, gone by half its shrinking, and grows on the new one the same way in reverse.
struct CalendarWeekStrip: View {

    // MARK: - Dependencies
    let selectedDay: String
    let today: String
    let onPick: (String) -> Void
    let onPage: (Int) -> Void

    /// Where a change of zoom finds the places it moves between.
    @Environment(\.calendarZoomMeasures)
    private var zoomMeasures

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
                            .background(circle(day))
                            .measuresZoomFrame(if: day == selectedDay) { zoomMeasures?.stripDay = $0 }
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

    /// The circle behind a day's number: whole on the selected day, shrunk and hidden on the others. It keeps its
    /// colour while it shrinks; it fades out over the first half of the shrinking and in over the second half of
    /// the growing, so it is gone while still half its size.
    func circle(_ day: String) -> some View {
        let isSelected = day == selectedDay
        return Circle()
            .fill(day == today ? Color.red : Color.primary)
            .scaleEffect(isSelected ? 1 : Self.shrunk)
            .animation(.easeInOut(duration: Self.duration), value: isSelected)
            .opacity(isSelected ? 1 : 0)
            .animation(
                isSelected
                    ? .easeOut(duration: Self.duration / 2).delay(Self.duration / 2)
                    : .easeIn(duration: Self.duration / 2),
                value: isSelected
            )
    }

    /// How small an unselected day's circle is: a circle shrinks to it and grows from it.
    static let shrunk = 0.2
}
