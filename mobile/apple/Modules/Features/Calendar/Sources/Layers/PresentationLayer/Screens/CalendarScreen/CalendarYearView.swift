import CoreKit
import DesignSystem
import SwiftUI

/// Years one after another in a vertical scroll, as the system Calendar shows them: each year its title and twelve
/// small months. A year scrolled to the top becomes the selected one; a tap on a month shows it.
struct CalendarYearView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel
    /// The paper behind the calendar, whose haze goes up and down with this scroll.
    let paper: PaperScroll

    /// Where a change of zoom finds the places it moves between.
    @Environment(\.calendarZoomMeasures)
    private var zoomMeasures

    // MARK: - State
    /// The year at the top of the scroll.
    @State private var topYear: Int?
    /// The year the scroll's years are laid out around; moved when the scroll nears either end.
    @State private var anchor: Int
    /// Set while a finger moves the scroll or it coasts after one; only then does the year at the top select itself.
    @State private var isScrolledByFinger = false

    // MARK: - Init
    init(state: CalendarState, viewModel: CalendarViewModel, paper: PaperScroll) {
        self.state = state
        self.viewModel = viewModel
        self.paper = paper
        let year = CalendarDates.year(state.selectedDay)
        _topYear = State(initialValue: year)
        _anchor = State(initialValue: year)
    }

    // MARK: - Body
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 28) {
                ForEach(years, id: \.self) { year in
                    section(year)
                }
            }
            .scrollTargetLayout()
        }
        .scrollIndicators(.hidden)
        .paperScrollFollowing(paper)
        .scrollPosition(id: $topYear, anchor: .top)
        .onScrollPhaseChange { _, phase in
            isScrolledByFinger = phase == .tracking || phase == .interacting || phase == .decelerating
            if phase == .idle { selectTopYear(force: true) }
        }
        .onChange(of: topYear) { selectTopYear(force: false) }
        .onChange(of: selectedYear) { _, year in
            guard year != topYear else { return }
            if abs(year - anchor) > Self.yearsAround - 2 { anchor = year }
            withAnimation(.smooth(duration: 0.35)) { topYear = year }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.yearGrid)
    }
}

// MARK: - Subviews
private extension CalendarYearView {

    /// Years laid out on each side of the anchor. The scroll measures every year before the one it shows, so the
    /// years are few and laid out again around the shown one when it nears either end.
    static var yearsAround: Int { 5 }

    var selectedYear: Int { CalendarDates.year(state.selectedDay) }

    var years: [Int] { ((anchor - Self.yearsAround)...(anchor + Self.yearsAround)).map { $0 } }

    func section(_ year: Int) -> some View {
        VStack(spacing: 12) {
            Text(verbatim: "\(year)")
                .font(.largeTitle.bold())
                .foregroundStyle(year == CalendarDates.year(state.today) ? Theme.Colors.today : .primary)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 12) {
                ForEach(1...12, id: \.self) { month in
                    let first = String(format: "%04d-%02d-01", year, month)
                    Button { show(first) } label: { miniMonth(first) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(CalendarDates.monthName(month: month)) \(year)")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    func miniMonth(_ first: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(CalendarDates.monthShortName(first))
                .font(.headline)
                .foregroundStyle(isCurrent(first) ? Theme.Colors.today : .primary)
            CalendarMiniMonthGrid(
                weeks: CalendarDates.weeks(ofMonth: first).map { week in week.map { $0.map(CalendarDates.dayNumber) } },
                today: isCurrent(first) ? CalendarDates.dayNumber(state.today) : nil
            )
        }
        .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
        .contentShape(Rectangle())
        // The small months of the selected year are where a change to and from a month zooms.
        .measuresZoomFrame(if: CalendarDates.year(first) == selectedYear) { frame in
            zoomMeasures?.monthFrames[CalendarDates.month(first)] = frame
        }
    }

    func isCurrent(_ first: String) -> Bool {
        first == CalendarDates.firstOfMonth(state.today)
    }

    func show(_ first: String) {
        viewModel.navigate(.show(zoom: .month, day: isCurrent(first) ? state.today : first))
    }

    /// Selects the year a finger brought to the top, on the selected day's date in it; at rest (`force`), also the
    /// one a scroll that ended without a finger left there, and lays the years out around it again when it nears
    /// either end.
    func selectTopYear(force: Bool) {
        guard let topYear, isScrolledByFinger || force, topYear != selectedYear else { return }
        let month = String(format: "%04d-%02d-01", topYear, CalendarDates.month(state.selectedDay))
        viewModel.navigate(.show(zoom: .year, day: CalendarDates.sameDay(as: state.selectedDay, inMonthOf: month)))
        if force, abs(topYear - anchor) > Self.yearsAround - 2 { anchor = topYear }
    }
}
