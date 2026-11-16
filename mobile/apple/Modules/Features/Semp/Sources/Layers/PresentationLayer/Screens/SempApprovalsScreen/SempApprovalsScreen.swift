import CoreKit
import DesignSystem
import SwiftUI

/// The requests of Semp that wait for the person's approval, and the ones already decided.
struct SempApprovalsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempApprovalsViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SempApprovalsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("semp.approvals.title", bundle: .module))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SempIdentifiers.approvals)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SempApprovalsScreen {

    var state: SempApprovalsState {
        viewModel.state
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sempMessage(for: failure)), retry: viewModel.retry))
        case .ready:
            list
        }
    }

    var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                Text("semp.approvals.intro", bundle: .module).font(.subheadline).foregroundStyle(.secondary)
                tabs
                if state.items.isEmpty { empty }
                ForEach(state.items) { item in card(item) }
                if state.hasMore {
                    Button { viewModel.send(.loadMore) } label: {
                        if state.loadingMore { ProgressView() } else { Text("semp.approvals.more", bundle: .module) }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(Theme.Spacing.medium)
        }
        .background(Theme.Colors.groupedBackground)
    }

    var tabs: some View {
        Picker(selection: tabBinding) {
            Text(pendingLabel).tag(SempApprovalsTab.pending)
            Text("semp.approvals.decided", bundle: .module).tag(SempApprovalsTab.decided)
        } label: {
            Text("semp.approvals.filter", bundle: .module)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier(SempIdentifiers.approvalsTabs)
    }

    var tabBinding: Binding<SempApprovalsTab> {
        Binding(get: { state.tab }, set: { viewModel.send(.setTab($0)) })
    }

    var pendingLabel: String {
        guard state.pendingCount > 0 else { return String(localized: "semp.approvals.pending", bundle: .module) }
        return String(
            format: String(localized: "semp.approvals.pending.count", bundle: .module),
            locale: .current,
            state.pendingCount
        )
    }

    var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(.secondary)
            Text(state.tab == .pending ? "semp.approvals.empty.pending" : "semp.approvals.empty.decided", bundle: .module)
                .font(.headline)
            Text(state.tab == .pending ? "semp.approvals.empty.pending.hint" : "semp.approvals.empty.decided.hint", bundle: .module)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Spacing.large)
    }

    func card(_ item: SempApprovalItem) -> some View {
        let open = state.expanded.contains(item.id)
        return SempApprovalCard(
            item: item,
            decide: { viewModel.send(.decide(approvalId: item.id, approve: $0)) },
            details: AnyView(details(item, open: open))
        )
    }

    func details(_ item: SempApprovalItem, open: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { viewModel.send(.toggleDetails(approvalId: item.id)) } label: {
                Text(open ? "semp.approvals.details.hide" : "semp.approvals.details.show", bundle: .module).font(.footnote)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.Colors.accent)
            .accessibilityIdentifier(SempIdentifiers.approvalDetails)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    Text("semp.approvals.parameters", bundle: .module).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    ForEach(item.argumentKeys, id: \.self) { key in
                        Text(key + " = \u{2022}\u{2022}\u{2022}").font(.footnote.monospaced())
                    }
                    Text("semp.approvals.parameters.note", bundle: .module).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        if item.threadId != nil {
                            Button { viewModel.send(.openThread(approvalId: item.id)) } label: {
                                Text("semp.approvals.thread", bundle: .module)
                            }
                        }
                        Button { viewModel.send(.openRun(approvalId: item.id)) } label: {
                            Text("semp.approvals.run", bundle: .module)
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }
}

#Preview {
    NavigationStack {
        SempApprovalsScreen(
            viewModel: SempApprovalsViewModel(
                model: ScriptedSempApprovalsScreenModel(
                    state: SempApprovalsState(
                        phase: .ready,
                        items: [
                            SempApprovalItem(
                                id: "a1",
                                descriptionKey: "approval.itemDelete",
                                descriptionParams: ["itemName": "Daňové přiznání", "databaseName": "Úkoly"],
                                argumentKeys: ["databaseId", "itemId"],
                                risk: .irreversible
                            )
                        ],
                        pendingCount: 1
                    )
                ),
                router: PreviewSempRouter()
            )
        )
    }
}
