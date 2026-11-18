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
            Text(verbatim: "\(CalendarDates.year(state.selectedDay))")
                .font(.largeTitle.bold())
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 12) {
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
        VStack(alignment: .leading, spacing: 4) {
            Text(CalendarDates.monthName(month: month.month))
                .font(.headline)
                .foregroundStyle(isCurrent(month) ? Color.red : .primary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 1) {
                // The blanks before the 1st count down from -1, apart from the days, which count up from 1.
                ForEach((0..<month.leading).map { -1 - $0 }, id: \.self) { _ in Color.clear.frame(height: 13) }
                ForEach(1...month.length, id: \.self) { day in
                    Text("\(day)")
                        .font(.system(size: 8.5, weight: isToday(month, day) ? .bold : .medium))
                        .foregroundStyle(isToday(month, day) ? AnyShapeStyle(Color.white) : AnyShapeStyle(.primary))
                        .frame(maxWidth: .infinity, minHeight: 13)
                        .background(
                            Circle().fill(isToday(month, day) ? Color.red : .clear).frame(width: 13, height: 13)
                        )
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
        .contentShape(Rectangle())
        .background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: CalendarMonthFramesKey.self,
                    value: [month.month: proxy.frame(in: .named(CalendarZoomTransition.space))]
                )
            }
        }
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
