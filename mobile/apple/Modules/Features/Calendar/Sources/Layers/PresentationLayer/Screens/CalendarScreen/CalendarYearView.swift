import CoreKit
import SwiftUI

/// A year as twelve small months. A tap on a month shows it; a swipe shows the next or the previous year.
struct CalendarYearView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel

    // MARK: - Body
    var body: some View {
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 16) {
                ForEach(state.months) { month in
                    Button { show(month) } label: { miniMonth(month) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(CalendarDates.monthName(month: month.month)) \(month.year)")
                }
            }
            .padding(16)
        }
        .gesture(swipe)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.yearGrid)
    }
}

// MARK: - Subviews
private extension CalendarYearView {

    func miniMonth(_ month: CalendarMonthState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(CalendarDates.monthName(month: month.month))
                .font(.headline)
                .foregroundStyle(isCurrent(month) ? Color.red : .primary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 2) {
                ForEach(0..<month.leading, id: \.self) { _ in Color.clear.frame(height: 15) }
                ForEach(1...month.length, id: \.self) { day in
                    Text("\(day)")
                        .font(.system(size: 9.5, weight: isToday(month, day) ? .bold : .medium))
                        .foregroundStyle(isToday(month, day) ? AnyShapeStyle(Color.white) : AnyShapeStyle(.primary))
                        .frame(maxWidth: .infinity, minHeight: 15)
                        .background(
                            Circle().fill(isToday(month, day) ? Color.red : .clear).frame(width: 15, height: 15)
                        )
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
        .contentShape(Rectangle())
    }

    func isCurrent(_ month: CalendarMonthState) -> Bool {
        CalendarDates.year(state.today) == month.year && CalendarDates.month(state.today) == month.month
    }

    func isToday(_ month: CalendarMonthState, _ day: Int) -> Bool {
        isCurrent(month) && CalendarDates.dayNumber(state.today) == day
    }

    func show(_ month: CalendarMonthState) {
        let first = String(format: "%04d-%02d-01", month.year, month.month)
        let keepsDay = isCurrent(month) ? state.today : first
        viewModel.navigate(.show(zoom: .month, day: keepsDay))
    }

    var swipe: some Gesture {
        DragGesture(minimumDistance: 30).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height) * 2 else { return }
            viewModel.navigate(.page(steps: value.translation.width < 0 ? 1 : -1))
        }
    }
}
