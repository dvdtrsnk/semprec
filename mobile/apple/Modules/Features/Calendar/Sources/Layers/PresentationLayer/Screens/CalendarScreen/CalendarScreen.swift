import CoreKit
import DesignSystem
import SwiftUI

/// The calendar: a year of months, a month of days or one day hour by hour, with the events and tasks of the day,
/// and the capsules for today, the calendars and the invitations. Every gesture goes to the shared ViewModel.
struct CalendarScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: CalendarViewModel
    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - State
    @State private var hasAppeared = false
    /// Counts the taps on Today, so the day view drops a day it chose that the shared state has not reached.
    @State private var todayRequests = 0
    /// The zoom on screen; it follows the shared state inside the animation of the change.
    @State private var shownZoom: CalendarZoom?
    @State private var zoomChanges = CalendarZoomChanges()
    /// Counts the changes of zoom, the layer of the view coming in.
    @State private var zoomLayer = 0.0
    /// The small months of the year view the last time it was laid out, and the size of the zoom space.
    @State private var zoomSpaceSize = CGSize.zero
    /// Where the views last laid out the places a change of zoom moves between.
    @State private var zoomMeasures = CalendarZoomMeasures()
    /// How far the shown view is scrolled, for the paper behind the calendar alone.
    @State private var paperScroll = PaperScroll()

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> CalendarViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarIdentifiers.screen)
            // A month and a year carry their large title in the content, as the system Calendar does.
            .navigationTitle(Text(verbatim: ""))
            .inlineNavigationTitle()
            .toolbar { toolbar }
            // Today answers as starting to select rows does in a note: a soft impact.
            .sensoryFeedback(.impact(flexibility: .soft), trigger: todayRequests)
            .safeAreaInset(edge: .bottom) {
                if viewModel.state.phase == .content {
                    CalendarBottomBar(
                        pendingInvitations: viewModel.state.pendingInvitations,
                        clipboard: viewModel.state.clipboard,
                        onToday: {
                            todayRequests += 1
                            viewModel.navigate(.goToday)
                        },
                        onCalendars: { viewModel.open(.calendars) },
                        onInvitations: { viewModel.open(.invitations) }
                    )
                }
            }
            .alert(
                Text("calendar.problem.title", bundle: .module),
                isPresented: problem
            ) {
                Button { viewModel.edit(.dismissProblem) } label: { Text("calendar.problem.dismiss", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: viewModel.state.problemFailure))
            }
            .task { await viewModel.observe() }
            .onAppear {
                if hasAppeared { viewModel.navigate(.refresh) }
                hasAppeared = true
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { viewModel.navigate(.refresh) }
            }
    }
}

// MARK: - Subviews
private extension CalendarScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(
                .failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.navigate(.retry) })
            )
        case .content:
            // The view coming in is drawn above the one going out, which keeps the layer it had.
            ZStack {
                switch displayedZoom {
                case .day:
                    CalendarDayView(
                        state: viewModel.state,
                        viewModel: viewModel,
                        todayRequests: todayRequests,
                        paper: paperScroll
                    )
                    // Measured in its own copy of the zoom space, beneath the transition: a view moving in or out
                    // reports where it rests, not where the change has carried it.
                    .coordinateSpace(.named(CalendarZoomTransition.space))
                    .transition(zoomChanges.transition(for: .day))
                    .zIndex(zoomLayer)
                case .month:
                    CalendarMonthView(state: viewModel.state, viewModel: viewModel, paper: paperScroll)
                        .coordinateSpace(.named(CalendarZoomTransition.space))
                        .transition(zoomChanges.transition(for: .month))
                        .zIndex(zoomLayer)
                case .year:
                    CalendarYearView(state: viewModel.state, viewModel: viewModel, paper: paperScroll)
                        .coordinateSpace(.named(CalendarZoomTransition.space))
                        .transition(zoomChanges.transition(for: .year))
                        .zIndex(zoomLayer)
                }
            }
            // A hidden month header tells how tall the real one is, so a first change from a day to a month knows
            // where the month's row of the day lies.
            .background(alignment: .top) {
                CalendarMonthHeader(title: CalendarDates.monthName(viewModel.state.selectedDay))
                    .hidden()
                    .accessibilityHidden(true)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }, action: { height in
                        zoomMeasures.monthHeaderHeight = height
                    })
            }
            .coordinateSpace(.named(CalendarZoomTransition.space))
            // The diary's paper, its haze moving with the shown view's scroll.
            .background { PaperBackground(scroll: paperScroll) }
            .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { zoomSpaceSize = $0 })
            .environment(\.calendarZoomMeasures, zoomMeasures)
            .onAppear { shownZoom = viewModel.state.zoom }
            .onChange(of: viewModel.state.zoom) { old, new in
                zoomChanges.current = CalendarZoomTransition(
                    source: old,
                    target: new,
                    month: CalendarDates.month(viewModel.state.selectedDay),
                    monthFrame: zoomMeasures.monthFrames[CalendarDates.month(viewModel.state.selectedDay)],
                    space: zoomSpaceSize,
                    stripDay: zoomMeasures.stripDay,
                    monthDay: zoomMeasures.monthDay?.offsetBy(dx: 0, dy: rowMove) ?? estimatedMonthDay
                )
                zoomLayer += 1
                // Another view starts at its own place, with the haze at the top.
                withAnimation(CalendarZoomTransition.animation) {
                    shownZoom = new
                    paperScroll.offset = 0
                }
            }
        }
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        PlainToolbarItem(placement: .navigation) {
            if let back = backLabel {
                // The arrow and the month or year it goes to, as a navigation back button shows them; a toolbar
                // would reduce a `Label` to its icon.
                Button { goBack() } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.backward")
                        // The name blurs into the next one, as a navigation back button's does.
                        Text(back)
                            .id(back)
                            .transition(.blurReplace)
                    }
                    .animation(CalendarZoomTransition.animation, value: back)
                }
                .accessibilityLabel(Text(back))
                .accessibilityIdentifier(CalendarIdentifiers.back)
            }
        }
        PlainToolbarItem(placement: .primaryAction) {
            Button { viewModel.open(.agenda(day: viewModel.state.selectedDay)) } label: {
                Label { Text("calendar.agenda", bundle: .module) } icon: { Image(systemName: "list.bullet") }
            }
            .accessibilityIdentifier(CalendarIdentifiers.agenda)
        }
        PlainToolbarItem(placement: .primaryAction) {
            Button { viewModel.open(.newItem(day: viewModel.state.selectedDay)) } label: {
                Label { Text("calendar.new", bundle: .module) } icon: { Image(systemName: "plus") }
            }
            .accessibilityIdentifier(CalendarIdentifiers.newItem)
        }
    }

    /// What the back button says: the month a day is in, or the year a month is in; a year has none.
    var backLabel: String? {
        switch viewModel.state.zoom {
        case .day: CalendarDates.monthName(viewModel.state.selectedDay)
        case .month: "\(CalendarDates.year(viewModel.state.selectedDay))"
        case .year: nil
        }
    }

    func goBack() {
        let zoom: CalendarZoom = viewModel.state.zoom == .day ? .month : .year
        viewModel.navigate(.show(zoom: zoom, day: viewModel.state.selectedDay))
    }

    /// The row of the month grid the selected day is in.
    var rowIndex: Int { (viewModel.state.monthGrid.firstIndex(of: viewModel.state.selectedDay) ?? 0) / 7 }

    /// How far the selected day's row lies from the row last measured.
    var rowMove: CGFloat {
        CGFloat(rowIndex - zoomMeasures.monthRowIndex) * (zoomMeasures.monthRow?.height ?? 0)
    }

    /// Where the selected day's number lies in a month that was not shown yet: below the header, in its week's row,
    /// at the top of the cell, with the selected month scrolled to the top as a month view first shows it.
    var estimatedMonthDay: CGRect? {
        guard let header = zoomMeasures.monthHeaderHeight, zoomSpaceSize.height > header else { return nil }
        let rowHeight = CalendarMonthView.rowHeight
        let top = header + CGFloat(rowIndex) * rowHeight + CalendarMonthCell.digitTop
        return CGRect(x: 0, y: top, width: CalendarMonthCell.digitSize, height: CalendarMonthCell.digitSize)
    }

    var displayedZoom: CalendarZoom { shownZoom ?? viewModel.state.zoom }

    var problem: Binding<Bool> {
        Binding(
            get: { viewModel.state.problem },
            set: { if !$0, viewModel.state.problem { viewModel.edit(.dismissProblem) } }
        )
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        CalendarScreen(
            viewModel: CalendarViewModel(
                model: ScriptedCalendarScreenModel(state: CalendarPreviewData.state()),
                router: PreviewCalendarRouter()
            )
        )
    }
}
