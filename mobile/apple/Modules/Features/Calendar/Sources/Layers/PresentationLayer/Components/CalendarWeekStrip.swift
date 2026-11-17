import SwiftUI

/// The seven days of the week of the selected day, Monday first: a tap shows that day, a swipe shows another week.
struct CalendarWeekStrip: View {

    // MARK: - Dependencies
    let selectedDay: String
    let today: String
    let onPick: (String) -> Void
    let onPage: (Int) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.self) { day in
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
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(CalendarDates.dayTitle(day))
                    .accessibilityIdentifier(CalendarIdentifiers.day(day))
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 24).onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                onPage(value.translation.width < 0 ? 7 : -7)
            }
        )
    }
}

// MARK: - Private
private extension CalendarWeekStrip {

    var days: [String] {
        let monday = CalendarDates.shifted(selectedDay, by: 1 - CalendarDates.isoWeekday(selectedDay))
        return (0..<7).map { CalendarDates.shifted(monday, by: $0) }
    }

    func numberStyle(_ day: String) -> AnyShapeStyle {
        if day == selectedDay { return AnyShapeStyle(.background) }
        if day == today { return AnyShapeStyle(Color.red) }
        return CalendarDates.isoWeekday(day) >= 6 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }

    func circleColor(_ day: String) -> Color {
        guard day == selectedDay else { return .clear }
        return day == today ? .red : .primary
    }
}
