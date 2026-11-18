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
    @State private var monthFrames: [Int: CGRect] = [:]
    @State private var zoomSpaceSize = CGSize.zero
    /// Where the selected day's digits were last in the day's week strip and in the month's grid.
    @State private var stripDay: CGRect?
    @State private var monthDay: CGRect?
    @State private var monthRow: CGRect?
    /// Which of the month's six rows `monthRow` was; a day since moved to another week moves the row by as many rows.
    @State private var monthRowIndex = 0

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
            .alert(deleteTitle, isPresented: deleting, presenting: viewModel.state.pendingDelete) { _ in
                Button(role: .destructive) { viewModel.edit(.confirmDelete) } label: {
                    Text("calendar.delete.confirm", bundle: .module)
                }
                Button(role: .cancel) { viewModel.edit(.cancelDelete) } label: {
                    Text("calendar.delete.cancel", bundle: .module)
                }
            } message: { request in
                Text(deleteMessage(request.kind), bundle: .module)
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
                        todayRequests: todayRequests
                    )
                    .transition(zoomChanges.transition(for: .day))
                    .zIndex(zoomLayer)
                case .month:
                    CalendarMonthView(state: viewModel.state, viewModel: viewModel)
                        .transition(zoomChanges.transition(for: .month))
                        .zIndex(zoomLayer)
                case .year:
                    CalendarYearView(state: viewModel.state, viewModel: viewModel)
                        .transition(zoomChanges.transition(for: .year))
                        .zIndex(zoomLayer)
                }
            }
            .coordinateSpace(.named(CalendarZoomTransition.space))
            .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { zoomSpaceSize = $0 })
            .onPreferenceChange(CalendarMonthFramesKey.self) { frames in
                if !frames.isEmpty { monthFrames = frames }
            }
            .onPreferenceChange(CalendarStripDayFrameKey.self) { frame in
                if frame != .zero { stripDay = frame }
            }
            .onPreferenceChange(CalendarMonthDayFrameKey.self) { frame in
                if frame != .zero { monthDay = frame }
            }
            .onPreferenceChange(CalendarMonthRowFrameKey.self) { frame in
                guard frame != .zero else { return }
                monthRow = frame
                monthRowIndex = rowIndex
            }
            .onAppear { shownZoom = viewModel.state.zoom }
            .onChange(of: viewModel.state.zoom) { old, new in
                zoomChanges.current = CalendarZoomTransition(
                    source: old,
                    target: new,
                    month: CalendarDates.month(viewModel.state.selectedDay),
                    monthFrame: monthFrames[CalendarDates.month(viewModel.state.selectedDay)],
                    space: zoomSpaceSize,
                    stripDay: stripDay,
                    monthDay: monthDay?.offsetBy(dx: 0, dy: rowMove),
                    monthRow: monthRow?.offsetBy(dx: 0, dy: rowMove)
                )
                zoomLayer += 1
                withAnimation(CalendarZoomTransition.animation) { shownZoom = new }
            }
        }
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
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
        ToolbarItem(placement: .primaryAction) {
            Button { viewModel.open(.agenda(day: viewModel.state.selectedDay)) } label: {
                Label { Text("calendar.agenda", bundle: .module) } icon: { Image(systemName: "list.bullet") }
            }
            .accessibilityIdentifier(CalendarIdentifiers.agenda)
        }
        ToolbarItem(placement: .primaryAction) {
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
    var rowMove: CGFloat { CGFloat(rowIndex - monthRowIndex) * (monthRow?.height ?? 0) }

    var displayedZoom: CalendarZoom { shownZoom ?? viewModel.state.zoom }

    var deleting: Binding<Bool> {
        Binding(
            get: { viewModel.state.pendingDelete != nil },
            set: { if !$0, viewModel.state.pendingDelete != nil { viewModel.edit(.cancelDelete) } }
        )
    }

    var problem: Binding<Bool> {
        Binding(
            get: { viewModel.state.problem },
            set: { if !$0, viewModel.state.problem { viewModel.edit(.dismissProblem) } }
        )
    }

    func deleteMessage(_ kind: CalendarItemKind) -> LocalizedStringKey {
        kind == .task ? "calendar.delete.task.message" : "calendar.delete.event.message"
    }

    var deleteTitle: Text {
        let isTask = viewModel.state.pendingDelete?.kind == .task
        let key = isTask ? "calendar.delete.task.title" : "calendar.delete.event.title"
        let name = viewModel.state.pendingDelete?.title ?? ""
        return Text(String(format: String(localized: String.LocalizationValue(key), bundle: .module), name))
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
