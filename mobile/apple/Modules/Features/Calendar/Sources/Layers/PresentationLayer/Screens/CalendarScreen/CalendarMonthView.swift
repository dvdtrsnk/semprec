import CoreKit
import SwiftUI

/// Months one after another in a vertical scroll, as the system Calendar shows them: each month only its own days by
/// week, Monday first, with its short name above its first day, and the large title naming the month at the top. A
/// month scrolled to the top becomes the selected one; a tap on a day opens it, and a chip dropped on a day moves its
/// item there.
struct CalendarMonthView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel

    // MARK: - State
    /// The first day of the month at the top of the scroll.
    @State private var topMonth: String?
    /// The month the scroll's months are laid out around; moved when the scroll nears either end.
    @State private var anchor: String
    /// Set while a finger moves the scroll or it coasts after one; only then does the month at the top select itself.
    @State private var isScrolledByFinger = false

    // MARK: - Init
    init(state: CalendarState, viewModel: CalendarViewModel) {
        self.state = state
        self.viewModel = viewModel
        let month = CalendarDates.firstOfMonth(state.selectedDay)
        _topMonth = State(initialValue: month)
        _anchor = State(initialValue: month)
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            Text(CalendarDates.monthName(topMonth ?? selectedMonth))
                .font(.largeTitle.bold())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            weekdays
            Divider()
            GeometryReader { proxy in
                // Six weeks fill the height, so a row's height is known before the first month is laid out.
                let rowHeight = max((proxy.size.height / 6).rounded(), 44)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(months, id: \.self) { month in
                            section(month, rowHeight: rowHeight)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollIndicators(.hidden)
                .scrollPosition(id: $topMonth, anchor: .top)
                // A month at the top starts with its first week; its short name stays above, under the title.
                .contentMargins(.top, -Self.labelHeight, for: .scrollContent)
                .onScrollPhaseChange { _, phase in
                    isScrolledByFinger = phase == .tracking || phase == .interacting || phase == .decelerating
                    if phase == .idle { selectTopMonth(force: true) }
                }
            }
            .onChange(of: topMonth) { selectTopMonth(force: false) }
            .onChange(of: selectedMonth) { _, month in
                guard month != topMonth else { return }
                if abs(offset(of: month)) > Self.monthsAround - 12 { anchor = month }
                withAnimation(.smooth(duration: 0.35)) { topMonth = month }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.monthGrid)
    }
}

// MARK: - Subviews
private extension CalendarMonthView {

    /// Months laid out on each side of the anchor.
    static var monthsAround: Int { 120 }

    /// The height of a month's short name above its first week.
    static var labelHeight: CGFloat { 34 }

    var selectedMonth: String { CalendarDates.firstOfMonth(state.selectedDay) }

    var months: [String] {
        (-Self.monthsAround...Self.monthsAround).map { CalendarDates.shiftedMonth(anchor, by: $0) }
    }

    var weekdays: some View {
        HStack(spacing: 0) {
            ForEach(1...7, id: \.self) { weekday in
                Text(CalendarDates.weekdayInitial(weekday))
                    .font(.caption2)
                    .foregroundStyle(weekday >= 6 ? .tertiary : .secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
    }

    /// One month: its short name above the column of its 1st, then its weeks.
    func section(_ month: String, rowHeight: CGFloat) -> some View {
        let weeks = CalendarDates.weeks(ofMonth: month)
        let isCurrent = month == CalendarDates.firstOfMonth(state.today)
        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(0..<7, id: \.self) { column in
                    Text(CalendarDates.monthShortName(month))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(isCurrent ? Color.red : .primary)
                        .opacity(column == CalendarDates.isoWeekday(month) - 1 ? 1 : 0)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: Self.labelHeight, alignment: .bottom)
            .accessibilityHidden(true)
            ForEach(weeks.indices, id: \.self) { index in
                week(weeks[index], rowHeight: rowHeight)
            }
        }
    }

    func week(_ dates: [String?], rowHeight: CGFloat) -> some View {
        HStack(spacing: 0) {
            ForEach(dates.indices, id: \.self) { column in
                if let date = dates[column] {
                    cell(date, rowHeight: rowHeight)
                } else {
                    Color.clear.frame(maxWidth: .infinity)
                }
            }
        }
        .frame(height: rowHeight)
        .reportsZoomFrame(CalendarMonthRowFrameKey.self, if: dates.contains(state.selectedDay))
    }

    func cell(_ date: String, rowHeight: CGFloat) -> some View {
        let items = state.days.first { $0.date == date }?.items ?? []
        return CalendarMonthCell(
            date: date,
            items: items,
            today: state.today,
            selected: date == state.selectedDay,
            isWeekday: CalendarDates.isoWeekday(date) < 6,
            maxChips: max(Int((rowHeight - 34) / 14), 0),
            onOpen: { viewModel.navigate(.show(zoom: .day, day: date)) },
            onDrop: { viewModel.gesture(.moveToDay(itemId: $0, day: date)) }
        )
    }

    /// How many months `month` is from the anchor.
    func offset(of month: String) -> Int {
        (CalendarDates.year(month) - CalendarDates.year(anchor)) * 12
            + CalendarDates.month(month) - CalendarDates.month(anchor)
    }

    /// Selects the month a finger brought to the top, on its day of the selected day's number; at rest (`force`),
    /// also the one a scroll that ended without a finger left there, and lays the months out around it again when it
    /// nears either end.
    func selectTopMonth(force: Bool) {
        guard let topMonth, isScrolledByFinger || force, topMonth != selectedMonth else { return }
        viewModel.navigate(.show(zoom: .month, day: CalendarDates.sameDay(as: state.selectedDay, inMonthOf: topMonth)))
        if force, abs(offset(of: topMonth)) > Self.monthsAround - 12 { anchor = topMonth }
    }
}
