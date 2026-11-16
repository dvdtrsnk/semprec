import CoreKit
import DesignSystem
import SwiftUI

/// The invitations sheet: the invitations that wait for an answer under New, the answered ones under Done. The sheet
/// sits in the app's navigation stack and closes itself.
struct InvitationsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: InvitationsViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> InvitationsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("invitations.title", tableName: "Sheets", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Text("invitations.done", tableName: "Sheets", bundle: .module) }
                        .accessibilityIdentifier(CalendarSheetIdentifiers.invitationsDone)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarSheetIdentifiers.invitationsScreen)
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
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension InvitationsScreen {

    var state: InvitationsState {
        viewModel.state
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sheetMessage(for: failure)), retry: viewModel.retry))
        case .content:
            List {
                Section {
                    if state.items.isEmpty {
                        empty
                    } else {
                        ForEach(state.items) { item in
                            InvitationRow(item: item, answering: state.answering) { reply in
                                viewModel.send(.answer(invitationId: item.id, reply: reply))
                            }
                        }
                    }
                } header: {
                    tabs
                }
            }
        }
    }

    var tabs: some View {
        Picker(selection: tab) {
            Text(pendingLabel).tag(InvitationsTab.pending)
            Text("invitations.tab.answered", tableName: "Sheets", bundle: .module).tag(InvitationsTab.answered)
        } label: {
            Text("invitations.tabs", tableName: "Sheets", bundle: .module)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .textCase(nil)
        .padding(.bottom, Theme.Spacing.small)
        .accessibilityIdentifier(CalendarSheetIdentifiers.invitationsTabs)
    }

    var tab: Binding<InvitationsTab> {
        Binding(
            get: { viewModel.state.tab },
            set: { viewModel.send(.showTab($0)) }
        )
    }

    var pendingLabel: String {
        guard state.pending > 0 else {
            return String(localized: "invitations.tab.pending", table: "Sheets", bundle: .module)
        }
        return String(
            format: String(localized: "invitations.tab.pendingCount", table: "Sheets", bundle: .module),
            locale: .current,
            state.pending
        )
    }

    var empty: some View {
        let pending = state.tab == .pending
        let title = pending ?
            String(localized: "invitations.empty.pending.title", table: "Sheets", bundle: .module)
            : String(localized: "invitations.empty.answered.title", table: "Sheets", bundle: .module)
        let message = pending ?
            String(localized: "invitations.empty.pending.message", table: "Sheets", bundle: .module)
            : String(localized: "invitations.empty.answered.message", table: "Sheets", bundle: .module)
        let details = Text(message).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
        let symbol = pending ? "tray" : "checkmark.circle"
        return StatusView(.empty(message: Text("\(title)\n\(details)"), systemImage: symbol))
            .listRowBackground(Color.clear)
    }

    var problemShown: Binding<Bool> {
        Binding(
            get: { viewModel.state.problem },
            set: { if !$0 { viewModel.send(.dismissProblem) } }
        )
    }
}

// MARK: - Preview
#Preview("New") {
    NavigationStack {
        InvitationsScreen(
            viewModel: InvitationsViewModel(model: ScriptedInvitationsScreenModel(state: .previewPending))
        )
    }
}

#Preview("Answered") {
    NavigationStack {
        InvitationsScreen(
            viewModel: InvitationsViewModel(model: ScriptedInvitationsScreenModel(state: .previewAnswered))
        )
    }
}

#Preview("Nothing new") {
    NavigationStack {
        InvitationsScreen(
            viewModel: InvitationsViewModel(
                model: ScriptedInvitationsScreenModel(state: InvitationsState(phase: .content))
            )
        )
    }
}

#Preview("Loading") {
    NavigationStack {
        InvitationsScreen(
            viewModel: InvitationsViewModel(
                model: ScriptedInvitationsScreenModel(state: InvitationsState(phase: .loading))
            )
        )
    }
}
