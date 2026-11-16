import CoreKit
import DesignSystem
import SwiftUI

/// The history of chats and automatic-task threads, with a search, a filter and the requests that wait for a decision.
struct SempChatsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempChatsViewModel
    @State private var query = ""

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SempChatsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("semp.chats.title", bundle: .module))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { viewModel.send(.openNewChat) } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel(Text("semp.newChat.open", bundle: .module))
                        .accessibilityIdentifier(SempIdentifiers.newChat)
                }
            }
            .searchable(text: $query, prompt: Text("semp.chats.search", bundle: .module))
            .onChange(of: query) { _, text in viewModel.send(.setQuery(text)) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SempIdentifiers.chats)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SempChatsScreen {

    var state: SempChatsState {
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
        List {
            Section { filter }
                .listRowBackground(Color.clear)
            if !state.approvals.isEmpty { approvals }
            ForEach(SempChatGroups.group(state.rows)) { group in
                Section { ForEach(group.rows) { row in rowButton(row) } } header: { Text(title(group.title)) }
            }
            if state.hasMore {
                Button { viewModel.send(.loadMore) } label: {
                    if state.loadingMore { ProgressView() } else { Text("semp.chats.more", bundle: .module) }
                }
                .frame(maxWidth: .infinity)
            }
            if state.rows.isEmpty { empty }
        }
        .groupedListStyle()
    }

    var filter: some View {
        Picker(selection: filterBinding) {
            Text("semp.chats.filter.all", bundle: .module).tag(SempChatsFilter.all)
            Text("semp.chats.filter.chats", bundle: .module).tag(SempChatsFilter.chats)
            Text("semp.chats.filter.ticks", bundle: .module).tag(SempChatsFilter.ticks)
        } label: {
            Text("semp.chats.filter", bundle: .module)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier(SempIdentifiers.chatsFilter)
    }

    var filterBinding: Binding<SempChatsFilter> {
        Binding(get: { state.filter }, set: { viewModel.send(.setFilter($0)) })
    }

    var approvals: some View {
        Section {
            ForEach(state.approvals) { item in
                SempApprovalCard(item: item) { approve in
                    viewModel.send(.decide(approvalId: item.id, approve: approve))
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        } header: {
            HStack {
                Text("semp.chats.approvals", bundle: .module)
                Text(String(state.approvalCount)).foregroundStyle(.secondary)
                Spacer()
                Button { viewModel.send(.openApprovals) } label: { Text("semp.chats.approvals.all", bundle: .module) }
                    .textCase(nil)
            }
        }
        .accessibilityIdentifier(SempIdentifiers.chatsApprovals)
    }

    func rowButton(_ row: SempChatRow) -> some View {
        Button { viewModel.send(.openThread(threadId: row.id)) } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if row.type == .tick {
                        Image(systemName: "clock.arrow.circlepath")
                            .imageScale(.small)
                            .foregroundStyle(Theme.Colors.accent)
                            .accessibilityLabel(Text("semp.chats.tick", bundle: .module))
                    }
                    Text(rowTitle(row)).font(.body.weight(.medium)).lineLimit(1)
                    if row.waiting {
                        Circle().fill(Theme.Colors.sempWaiting).frame(width: 8, height: 8)
                            .accessibilityLabel(Text("semp.chats.waiting", bundle: .module))
                    }
                    Spacer(minLength: 4)
                    Text(SempTime.listLabel(row.lastActivityAt) ?? "").font(.caption).foregroundStyle(.secondary)
                }
                if let preview = preview(row) {
                    Text(preview).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .listRowButton()
        .accessibilityIdentifier(SempIdentifiers.chatRowPrefix + row.id)
    }

    var empty: some View {
        VStack(spacing: 4) {
            Text("semp.chats.empty", bundle: .module).font(.headline)
            Text("semp.chats.empty.hint", bundle: .module).font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .listRowBackground(Color.clear)
    }

    func title(_ title: SempChatGroups.Title) -> String {
        switch title {
        case .today: String(localized: "semp.chats.today", bundle: .module)
        case .yesterday: String(localized: "semp.chats.yesterday", bundle: .module)
        case .previousWeek: String(localized: "semp.chats.week", bundle: .module)
        case .month(let date): date.formatted(.dateTime.month(.wide).year())
        }
    }

    func rowTitle(_ row: SempChatRow) -> String {
        if let title = row.title, !title.isEmpty { return title }
        switch row.type {
        case .item: return String(localized: "semp.chats.untitled.item", bundle: .module)
        case .tick: return String(localized: "semp.chats.untitled.tick", bundle: .module)
        case .chat: return row.previewText.map { String($0.prefix(40)) }
            ?? String(localized: "semp.chats.untitled", bundle: .module)
        }
    }

    func preview(_ row: SempChatRow) -> String? {
        if let text = row.previewText { return text }
        switch row.previewSystemKey {
        case "approval.outcome.executed": return String(localized: "semp.system.executed", bundle: .module)
        case "approval.outcome.rejected": return String(localized: "semp.system.rejected", bundle: .module)
        case "approval.outcome.conflict": return String(localized: "semp.system.conflict", bundle: .module)
        default: return nil
        }
    }
}

#Preview {
    NavigationStack {
        SempChatsScreen(
            viewModel: SempChatsViewModel(
                model: ScriptedSempChatsScreenModel(
                    state: SempChatsState(
                        phase: .ready,
                        rows: [
                            SempChatRow(
                                id: "1",
                                type: .chat,
                                title: "Plán na dnešek",
                                previewText: "Hotovo. Upravil jsem jeden úkol…",
                                lastActivityAt: "2026-10-21T13:21:00.000Z"
                            )
                        ]
                    )
                ),
                router: PreviewSempRouter()
            )
        )
    }
}
