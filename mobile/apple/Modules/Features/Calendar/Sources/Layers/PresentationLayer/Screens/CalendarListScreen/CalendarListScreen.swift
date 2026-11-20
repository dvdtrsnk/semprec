import CoreKit
import DesignSystem
import SwiftUI

/// The calendars sheet: the calendars grouped by where they come from, each shown or hidden with one tap, and the
/// settings of one calendar on a page inside the sheet, opened by the shared state's `detailId`. The sheet sits in the
/// app's navigation stack and closes itself.
struct CalendarListScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: CalendarListViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> CalendarListViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(title)
            .inlineNavigationTitle()
            .toolbar { toolbar }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsScreen)
            .alert(
                Text("sheets.failure.title", tableName: "Sheets", bundle: .module),
                isPresented: problemShown,
                actions: {
                    Button { viewModel.send(.dismissProblem) } label: {
                        Text("sheets.failure.dismiss", tableName: "Sheets", bundle: .module)
                    }
                },
                message: { Text(FailureKind.sheetMessage(for: viewModel.state.problemFailure)) }
            )
            .alert(
                deleteTitle,
                isPresented: deleteAsked,
                presenting: viewModel.state.impact,
                actions: { _ in
                    Button(role: .destructive) { viewModel.send(.confirmDelete) } label: {
                        Text("calendars.delete.confirm", tableName: "Sheets", bundle: .module)
                    }
                    Button(role: .cancel) { viewModel.send(.cancelDelete) } label: {
                        Text("calendars.delete.cancel", tableName: "Sheets", bundle: .module)
                    }
                },
                message: { Text($0.message) }
            )
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension CalendarListScreen {

    var state: CalendarListState {
        viewModel.state
    }

    var send: (CalendarListAction) -> Void {
        { [viewModel] in viewModel.send($0) }
    }

    var detail: CalendarRow? {
        state.detailId.flatMap { id in state.calendars.first { $0.id == id } }
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sheetMessage(for: failure)), retry: viewModel.retry))
        case .content:
            if let detail {
                CalendarDetailPage(calendar: detail, swatches: state.swatches, busy: state.busy, send: send)
                    .id(detail.id)
            } else {
                list
            }
        }
    }

    var list: some View {
        List {
            group(.own, title: Text("calendars.group.own", tableName: "Sheets", bundle: .module))
            group(.system, title: Text("calendars.group.system", tableName: "Sheets", bundle: .module))
            group(.subscription, title: Text("calendars.group.subscription", tableName: "Sheets", bundle: .module))
            Section {
                Button(action: addCalendar) {
                    Label {
                        Text("calendars.add", tableName: "Sheets", bundle: .module)
                    } icon: {
                        Image(systemName: "plus.circle.fill")
                    }
                }
                .listRowButton()
                .disabled(state.busy)
                .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsAdd)
            } footer: {
                Text("calendars.footer", tableName: "Sheets", bundle: .module)
            }
        }
    }

    /// Adds a calendar with a default name; the shared ViewModel opens its settings once it exists.
    func addCalendar() {
        send(.add(name: String(localized: "calendars.add.defaultName", table: "Sheets", bundle: .module)))
    }

    @ViewBuilder
    func group(_ group: CalendarGroup, title: Text) -> some View {
        let rows = state.calendars.filter { $0.group == group }
        if !rows.isEmpty {
            Section {
                ForEach(rows) { CalendarListRow(calendar: $0, send: send) }
            } header: {
                title
            }
        }
    }

    var title: Text {
        guard let detail else { return Text("calendars.title", tableName: "Sheets", bundle: .module) }
        guard detail.canRename else { return Text(detail.name) }
        return Text("calendars.detail.editTitle", tableName: "Sheets", bundle: .module)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        if detail == nil {
            PlainToolbarItem(placement: .navigation) {
                toggleAllButton
            }
            ToolbarItem(placement: .confirmationAction) {
                Button { dismiss() } label: { Text("calendars.done", tableName: "Sheets", bundle: .module) }
                    .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsDone)
            }
        } else {
            PlainToolbarItem(placement: .navigation) {
                Button { send(.closeDetail) } label: {
                    Label {
                        Text("calendars.detail.back", tableName: "Sheets", bundle: .module)
                    } icon: {
                        Image(systemName: "chevron.backward")
                    }
                }
                .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsBack)
            }
        }
    }

    @ViewBuilder var toggleAllButton: some View {
        if case .content = state.phase, !state.calendars.isEmpty {
            let anyShown = state.calendars.contains { !$0.hidden }
            Button { send(.setAllHidden(anyShown)) } label: {
                if anyShown {
                    Text("calendars.hideAll", tableName: "Sheets", bundle: .module)
                } else {
                    Text("calendars.showAll", tableName: "Sheets", bundle: .module)
                }
            }
            .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsToggleAll)
        }
    }

    var problemShown: Binding<Bool> {
        Binding(
            get: { viewModel.state.problem },
            set: { if !$0 { viewModel.send(.dismissProblem) } }
        )
    }

    var deleteAsked: Binding<Bool> {
        Binding(
            get: { viewModel.state.impact != nil },
            set: { if !$0 { viewModel.send(.cancelDelete) } }
        )
    }

    var deleteTitle: Text {
        let name = state.impact.flatMap { impact in state.calendars.first { $0.id == impact.calendarId }?.name } ?? ""
        return Text(String(
            format: String(localized: "calendars.delete.title", table: "Sheets", bundle: .module),
            locale: .current,
            name
        ))
    }
}

// MARK: - Preview
#Preview("Calendars") {
    NavigationStack {
        CalendarListScreen(
            viewModel: CalendarListViewModel(
                model: ScriptedCalendarListScreenModel(state: .previewList),
                router: PreviewCalendarRouter()
            )
        )
    }
}

#Preview("Detail") {
    NavigationStack {
        CalendarListScreen(
            viewModel: CalendarListViewModel(
                model: ScriptedCalendarListScreenModel(state: .previewDetail),
                router: PreviewCalendarRouter()
            )
        )
    }
}

#Preview("Delete") {
    NavigationStack {
        CalendarListScreen(
            viewModel: CalendarListViewModel(
                model: ScriptedCalendarListScreenModel(state: .previewDelete),
                router: PreviewCalendarRouter()
            )
        )
    }
}

#Preview("Unavailable") {
    NavigationStack {
        CalendarListScreen(
            viewModel: CalendarListViewModel(
                model: ScriptedCalendarListScreenModel(state: CalendarListState(phase: .failure(.unavailable))),
                router: PreviewCalendarRouter()
            )
        )
    }
}
