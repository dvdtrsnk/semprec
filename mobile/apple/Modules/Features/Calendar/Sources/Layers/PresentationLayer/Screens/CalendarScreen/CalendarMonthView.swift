import CoreKit
import DesignSystem
import SwiftUI

/// Months one after another in a vertical scroll, as the system Calendar shows them: each month only its own days by
/// week, Monday first, with its short name above its first day, and the large title naming the month at the top. A
/// month scrolled to the top becomes the selected one; a tap on a day opens it, and a chip dropped on a day moves its
/// item there.
struct CalendarMonthView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel
    /// The paper behind the calendar, whose haze goes up and down with this scroll.
    let paper: PaperScroll

    /// Where a change of zoom finds the places it moves between.
    @Environment(\.calendarZoomMeasures)
    private var zoomMeasures

    // MARK: - State
    /// The first day of the month at the top of the scroll.
    @State private var topMonth: String?
    /// The month the scroll's months are laid out around; moved when the scroll nears either end.
    @State private var anchor: String
    /// Set while a finger moves the scroll or it coasts after one; only then does the month at the top select itself.
    @State private var isScrolledByFinger = false
    @State private var cache = CalendarKeyCache()

    // MARK: - Init
    init(state: CalendarState, viewModel: CalendarViewModel, paper: PaperScroll) {
        self.state = state
        self.viewModel = viewModel
        self.paper = paper
        let month = CalendarDates.firstOfMonth(state.selectedDay)
        _topMonth = State(initialValue: month)
        _anchor = State(initialValue: month)
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            CalendarMonthHeader(
                title: CalendarDates.monthName(topMonth ?? selectedMonth),
                isCurrent: (topMonth ?? selectedMonth) == CalendarDates.firstOfMonth(state.today)
            )
            GeometryReader { proxy in
                // Six weeks fill the height, so a row's height is known before the first month is laid out.
                let rowHeight = Self.rowHeight(gridHeight: proxy.size.height)
                let items = itemsByDate
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(months, id: \.self) { month in
                            section(month, rowHeight: rowHeight, items: items)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollIndicators(.hidden)
                .paperScrollFollowing(paper)
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
                if abs(offset(of: month)) > Self.monthsAround - 4 { anchor = month }
                withAnimation(.smooth(duration: 0.35)) { topMonth = month }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.monthGrid)
    }
}

// MARK: - Layout
extension CalendarMonthView {

    /// The height of a week: six of them fill the grid below the header.
    static func rowHeight(gridHeight: CGFloat) -> CGFloat {
        max((gridHeight / 6).rounded(), 44)
    }
}

// MARK: - Subviews
private extension CalendarMonthView {

    /// Months laid out on each side of the anchor. The scroll measures every month before the one it shows, so the
    /// months are few and laid out again around the shown one when it nears either end.
    static var monthsAround: Int { 12 }

    /// The height of a month's short name above its first week.
    static var labelHeight: CGFloat { 34 }

    var selectedMonth: String { CalendarDates.firstOfMonth(state.selectedDay) }

    var months: [String] {
        cache.keys(around: anchor) { center in
            (-Self.monthsAround...Self.monthsAround).map { CalendarDates.shiftedMonth(center, by: $0) }
        }
    }

    /// The items of the loaded days by their date, looked up once per update rather than once per day.
    var itemsByDate: [String: [CalendarItem]] {
        Dictionary(state.days.map { ($0.date, $0.items) }, uniquingKeysWith: { first, _ in first })
    }

    /// One month: its short name above the column of its 1st, then its weeks.
    func section(_ month: String, rowHeight: CGFloat, items: [String: [CalendarItem]]) -> some View {
        let weeks = CalendarDates.weeks(ofMonth: month)
        let isCurrent = month == CalendarDates.firstOfMonth(state.today)
        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(0..<7, id: \.self) { column in
                    Text(CalendarDates.monthShortName(month))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(isCurrent ? Theme.Colors.today : .primary)
                        .opacity(column == CalendarDates.isoWeekday(month) - 1 ? 1 : 0)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: Self.labelHeight, alignment: .bottom)
            .modifier(CalendarZoomFade())
            .accessibilityHidden(true)
            ForEach(weeks.indices, id: \.self) { index in
                week(weeks[index], index: index, rowHeight: rowHeight, items: items)
            }
        }
    }

    func week(_ dates: [String?], index: Int, rowHeight: CGFloat, items: [String: [CalendarItem]]) -> some View {
        let isKept = dates.contains(state.selectedDay)
        return HStack(spacing: 0) {
            ForEach(dates.indices, id: \.self) { column in
                if let date = dates[column] {
                    cell(date, rowHeight: rowHeight, items: items[date] ?? [])
                } else {
                    Color.clear.frame(maxWidth: .infinity)
                }
            }
        }
        .frame(height: rowHeight)
        // The row of the selected day stays whole while the month changes to or from that day.
        .modifier(CalendarZoomFade(isKept: isKept))
        .measuresZoomFrame(if: isKept) { frame in
            zoomMeasures?.monthRow = frame
            zoomMeasures?.monthRowIndex = index
        }
    }

    func cell(_ date: String, rowHeight: CGFloat, items: [CalendarItem]) -> some View {
        CalendarMonthCell(
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
        if force, abs(offset(of: topMonth)) > Self.monthsAround - 4 { anchor = topMonth }
    }
}
