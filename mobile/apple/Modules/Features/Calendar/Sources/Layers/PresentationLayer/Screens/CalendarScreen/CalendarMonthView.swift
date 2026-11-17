import CoreKit
import SwiftUI

/// A month as six weeks of days, Monday first, with the chips of what is on each day. A swipe shows the next or the
/// previous month; a tap on a day opens it, and a chip dropped on a day moves its item there.
struct CalendarMonthView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            weekdays
            GeometryReader { proxy in
                let rowHeight = proxy.size.height / 6
                VStack(spacing: 0) {
                    ForEach(0..<6, id: \.self) { week in
                        HStack(spacing: 0) {
                            ForEach(days(in: week), id: \.self) { date in
                                cell(date, rowHeight: rowHeight)
                            }
                        }
                        .frame(height: rowHeight)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .gesture(swipe)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.monthGrid)
    }
}

// MARK: - Subviews
private extension CalendarMonthView {

    var weekdays: some View {
        HStack(spacing: 0) {
            ForEach(1...7, id: \.self) { weekday in
                Text(CalendarDates.weekdayShort(weekday))
                    .font(.caption2)
                    .foregroundStyle(weekday >= 6 ? .tertiary : .secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
    }

    func days(in week: Int) -> [String] {
        let grid = state.monthGrid
        guard grid.count >= (week + 1) * 7 else { return [] }
        return Array(grid[(week * 7)..<(week * 7 + 7)])
    }

    func cell(_ date: String, rowHeight: CGFloat) -> some View {
        let items = state.days.first { $0.date == date }?.items ?? []
        return CalendarMonthCell(
            date: date,
            items: items,
            today: state.today,
            selected: date == state.selectedDay,
            inMonth: CalendarDates.month(date) == CalendarDates.month(state.selectedDay),
            maxChips: max(Int((rowHeight - 34) / 14), 0),
            onOpen: { viewModel.navigate(.show(zoom: .day, day: date)) },
            onDrop: { viewModel.gesture(.moveToDay(itemId: $0, day: date)) },
            onOpenItem: { viewModel.gesture(.tap(itemId: $0)) }
        )
    }

    var swipe: some Gesture {
        DragGesture(minimumDistance: 30).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height) * 2 else { return }
            viewModel.navigate(.page(steps: value.translation.width < 0 ? 1 : -1))
        }
    }
}
