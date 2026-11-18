import CoreKit
import SwiftUI

/// Years one after another in a vertical scroll, as the system Calendar shows them: each year its title and twelve
/// small months. A year scrolled to the top becomes the selected one; a tap on a month shows it.
struct CalendarYearView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel

    // MARK: - State
    /// The year at the top of the scroll.
    @State private var topYear: Int?
    /// The year the scroll's years are laid out around; moved when the scroll nears either end.
    @State private var anchor: Int
    /// Set while a finger moves the scroll or it coasts after one; only then does the year at the top select itself.
    @State private var isScrolledByFinger = false

    // MARK: - Init
    init(state: CalendarState, viewModel: CalendarViewModel) {
        self.state = state
        self.viewModel = viewModel
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
        .scrollPosition(id: $topYear, anchor: .top)
        .onScrollPhaseChange { _, phase in
            isScrolledByFinger = phase == .tracking || phase == .interacting || phase == .decelerating
            if phase == .idle { selectTopYear(force: true) }
        }
        .onChange(of: topYear) { selectTopYear(force: false) }
        .onChange(of: selectedYear) { _, year in
            guard year != topYear else { return }
            if abs(year - anchor) > Self.yearsAround - 3 { anchor = year }
            withAnimation(.smooth(duration: 0.35)) { topYear = year }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.yearGrid)
    }
}

// MARK: - Subviews
private extension CalendarYearView {

    /// Years laid out on each side of the anchor.
    static var yearsAround: Int { 30 }

    var selectedYear: Int { CalendarDates.year(state.selectedDay) }

    var years: [Int] { ((anchor - Self.yearsAround)...(anchor + Self.yearsAround)).map { $0 } }

    func section(_ year: Int) -> some View {
        VStack(spacing: 12) {
            Text(verbatim: "\(year)")
                .font(.largeTitle.bold())
                .foregroundStyle(year == CalendarDates.year(state.today) ? Color.red : .primary)
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
                .foregroundStyle(isCurrent(first) ? Color.red : .primary)
            VStack(spacing: 1) {
                ForEach(Array(CalendarDates.weeks(ofMonth: first).enumerated()), id: \.offset) { _, week in
                    HStack(spacing: 0) {
                        ForEach(week.indices, id: \.self) { column in
                            day(week[column])
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
        .contentShape(Rectangle())
        .background {
            // The small months of the selected year are where a change to and from a month zooms.
            if CalendarDates.year(first) == selectedYear {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: CalendarMonthFramesKey.self,
                        value: [CalendarDates.month(first): proxy.frame(in: .named(CalendarZoomTransition.space))]
                    )
                }
            }
        }
    }

    func day(_ date: String?) -> some View {
        let isToday = date == state.today
        return Text(date.map { "\(CalendarDates.dayNumber($0))" } ?? "")
            .font(.system(size: 8.5, weight: isToday ? .bold : .medium))
            .foregroundStyle(isToday ? AnyShapeStyle(Color.white) : AnyShapeStyle(.primary))
            .frame(maxWidth: .infinity, minHeight: 13)
            .background(Circle().fill(isToday ? Color.red : .clear).frame(width: 13, height: 13))
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
        if force, abs(topYear - anchor) > Self.yearsAround - 3 { anchor = topYear }
    }
}
