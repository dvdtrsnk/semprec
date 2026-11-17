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

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> CalendarViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarIdentifiers.screen)
            .navigationTitle(Text(title))
            .inlineNavigationTitle()
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) {
                if viewModel.state.phase == .content {
                    CalendarBottomBar(
                        pendingInvitations: viewModel.state.pendingInvitations,
                        clipboard: viewModel.state.clipboard,
                        onToday: { viewModel.navigate(.goToday) },
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
            switch viewModel.state.zoom {
            case .day: CalendarDayView(state: viewModel.state, viewModel: viewModel)
            case .month: CalendarMonthView(state: viewModel.state, viewModel: viewModel)
            case .year: CalendarYearView(state: viewModel.state, viewModel: viewModel)
            }
        }
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            if let back = backLabel {
                Button { goBack() } label: {
                    Label { Text(back) } icon: { Image(systemName: "chevron.backward") }
                }
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

    var title: String {
        switch viewModel.state.zoom {
        case .day: ""
        case .month: CalendarDates.monthName(viewModel.state.selectedDay)
        case .year: "\(CalendarDates.year(viewModel.state.selectedDay))"
        }
    }

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
