import CoreKit
import DesignSystem
import SwiftUI

/// The things the person deleted: items and databases, kept for 30 days. Each row has its own restore, and several
/// rows can be chosen and restored together.
struct TrashScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: TrashViewModel

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> TrashViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            Picker(selection: tab) {
                Text("trash.tab.items", bundle: .module).tag(TrashTab.items)
                Text("trash.tab.databases", bundle: .module).tag(TrashTab.databases)
            } label: {
                Text("trash.title", bundle: .module)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
            .accessibilityIdentifier(AccountIdentifiers.trashTabPrefix + "picker")
            content
        }
        .background(Theme.Colors.groupedBackground)
        .navigationTitle(Text("trash.title", bundle: .module))
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { viewModel.toggleSelecting() } label: {
                    Text(viewModel.state.selecting ? "trash.done" : "trash.select", bundle: .module)
                }
                .accessibilityIdentifier(AccountIdentifiers.trashSelect)
            }
        }
        .safeAreaInset(edge: .bottom) { selectionBar }
        .overlay(alignment: .bottom) { noticeView }
        .alert(
            Text("trash.failed", bundle: .module),
            isPresented: Binding(get: { viewModel.state.writeFailure != nil }, set: { _ in viewModel.dismissFailure() })
        ) {
            Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
        } message: {
            Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AccountIdentifiers.trashScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension TrashScreen {

    var tab: Binding<TrashTab> {
        Binding(get: { viewModel.state.tab }, set: { viewModel.select($0) })
    }

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: { viewModel.retry() })
            )
        case .content:
            if isEmpty {
                StatusView(.empty(message: Text(emptyText), systemImage: "trash"))
            } else {
                list
            }
        }
    }

    var isEmpty: Bool {
        viewModel.state.tab == .items ? viewModel.state.items.isEmpty : viewModel.state.databases.isEmpty
    }

    var emptyText: LocalizedStringKey {
        viewModel.state.tab == .items ? "trash.empty.items" : "trash.empty.databases"
    }

    var list: some View {
        List {
            Section {
                switch viewModel.state.tab {
                case .items:
                    ForEach(viewModel.state.items) { item in
                        row(
                            id: item.id,
                            title: item.title.isEmpty ? String(
                                localized: "trash.untitled",
                                bundle: .module
                            ) : item.title,
                            meta: Self.meta(of: item)
                        )
                    }
                    if viewModel.state.hasMore {
                        Color.clear.frame(height: 1).onAppear { viewModel.loadMore() }
                    }
                case .databases:
                    ForEach(viewModel.state.databases) { database in
                        row(id: database.id, title: database.name, meta: Self.meta(of: database))
                    }
                }
            } footer: {
                Text(viewModel.state.tab == .items ? "trash.footer.items" : "trash.footer.databases", bundle: .module)
            }
        }
        .disabled(viewModel.state.working)
    }

    func row(id: String, title: String, meta: String) -> some View {
        let selected = viewModel.state.selected.contains(id)
        return HStack(spacing: Theme.Spacing.medium) {
            if viewModel.state.selecting {
                Button { viewModel.toggle(id) } label: {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(selected ? Theme.Colors.accent : Theme.Colors.secondaryText)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).lineLimit(1)
                Text(meta).font(.footnote).foregroundStyle(Theme.Colors.secondaryText).lineLimit(2)
            }
            Spacer(minLength: Theme.Spacing.small)
            if !viewModel.state.selecting {
                Button { viewModel.restore(id) } label: { Text("trash.restore", bundle: .module) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(AccountIdentifiers.trashRestorePrefix + id)
            }
        }
        .accessibilityIdentifier(AccountIdentifiers.trashRowPrefix + id)
    }

    @ViewBuilder var selectionBar: some View {
        if viewModel.state.selecting {
            HStack {
                Button { viewModel.selectAll() } label: { Text("trash.selectAll", bundle: .module) }
                    .accessibilityIdentifier(AccountIdentifiers.trashSelectAll)
                Spacer()
                Text(selectedText).foregroundStyle(Theme.Colors.secondaryText)
                Spacer()
                Button { viewModel.restoreSelected() } label: { Text("trash.restore", bundle: .module) }
                    .disabled(viewModel.state.selected.isEmpty)
                    .accessibilityIdentifier(AccountIdentifiers.trashRestoreSelected)
            }
            .padding(Theme.Spacing.medium)
            .background(.bar)
        }
    }

    @ViewBuilder var noticeView: some View {
        if let notice = viewModel.notice {
            Label(notice, systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.vertical, Theme.Spacing.small)
                .glassEffect(.regular, in: .capsule)
                .padding(.bottom, Theme.Spacing.large * 2)
                .accessibilityIdentifier(AccountIdentifiers.trashToast)
        }
    }

    var selectedText: String {
        let count = viewModel.state.selected.count
        return count == 0
            ? String(localized: "trash.selected.none", bundle: .module)
            : String(format: String(localized: "trash.selected.count", bundle: .module), count)
    }

    static func meta(of item: TrashItemRow) -> String {
        let deleted = AccountFormat.relative(item.deletedAt).map {
            String(format: String(localized: "trash.deleted", bundle: .module), $0)
        }
        let left = String(format: String(localized: "trash.daysLeft", bundle: .module), item.daysLeft)
        return [item.databaseName, deleted, left].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func meta(of database: TrashDatabaseRow) -> String {
        let items = String(format: String(localized: "trash.database.items", bundle: .module), database.itemCount)
        let left = database.daysLeft.map { String(format: String(localized: "trash.daysLeft", bundle: .module), $0) }
        return [items, left].compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        TrashScreen(
            viewModel: TrashViewModel(
                model: ScriptedTrashScreenModel(
                    state: TrashState(
                        phase: .content,
                        items: [
                            TrashItemRow(
                                id: "i1",
                                title: "Vymenit zarovku",
                                databaseKey: "tasks",
                                databaseName: "Ukoly",
                                deletedAt: "2026-10-20T10:00:00Z",
                                daysLeft: 29
                            )
                        ]
                    )
                )
            )
        )
    }
}
