import CoreKit
import DesignSystem
import SwiftUI

/// The thread list of the mail: a search, quick filters, the areas and projects the threads belong to, a notice for a
/// mailbox that needs signing in again, and the threads. It is the one screen for all mail, an area, a project, a
/// folder and a mailbox: the model it is made over carries which.
struct MailThreadsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: MailThreadsViewModel
    private let title: String?

    // MARK: - State
    @State private var query = ""
    @State private var filterOpen = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> MailThreadsViewModel, title: String?) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.title = title
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text(verbatim: title ?? String(localized: "mail.title", bundle: .module)))
            .toolbar {
                PlainToolbarItemGroup(placement: .primaryAction) {
                    Button { viewModel.send(.open(.openFolders)) } label: {
                        Label { Text("mail.folders", bundle: .module) } icon: { Image(systemName: "folder") }
                    }
                    .accessibilityIdentifier(MailIdentifiers.threadsFolders)
                    Button { viewModel.send(.open(.compose)) } label: {
                        Label { Text("mail.compose", bundle: .module) } icon: { Image(systemName: "square.and.pencil") }
                    }
                    .accessibilityIdentifier(MailIdentifiers.threadsCompose)
                }
            }
            .searchable(text: $query, prompt: Text("mail.search.prompt", bundle: .module))
            .onSubmit(of: .search) { viewModel.send(.search(query)) }
            .onChange(of: query) { _, new in
                if new.isEmpty { viewModel.send(.search("")) }
            }
            .sheet(isPresented: $filterOpen) {
                MailFilterSheet(state: viewModel.state, send: viewModel.send)
            }
            .alert(
                Text("mail.failure.title", bundle: .module),
                isPresented: actionFailed,
                actions: { dismissButton },
                message: { Text("mail.failure.message", bundle: .module) }
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(MailIdentifiers.threadsScreen)
            .task { await viewModel.observe() }
            .onAppear { viewModel.appeared() }
    }
}

// MARK: - Subviews
private extension MailThreadsScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.send(.retry) }))
        case .content:
            list
        }
    }

    var list: some View {
        List {
            Section {
                filterBar
                ForEach(viewModel.state.reauthorization) { notice in reauthorization(notice) }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            if viewModel.state.threads.isEmpty {
                Section { empty }
            } else {
                Section {
                    ForEach(viewModel.state.threads) { thread in row(thread) }
                    if viewModel.state.hasMore { more }
                }
            }
        }
        .groupedListStyle()
        .refreshable { await viewModel.refresh() }
    }

    func row(_ thread: MailThreadItem) -> some View {
        MailThreadRow(thread: thread) { viewModel.send(.open(.openThread(threadId: thread.threadId))) }
            .accessibilityIdentifier(MailIdentifiers.threadRowPrefix + thread.threadId)
            .dropTarget(
                SempTarget(kind: .mail, title: thread.subject, meta: thread.senderName, mailThreadId: thread.threadId)
            )
            .swipeActions(edge: .leading) { readToggle(thread) }
            .contextMenu { readToggle(thread) }
    }

    func readToggle(_ thread: MailThreadItem) -> some View {
        Button { viewModel.send(.toggleRead(threadId: thread.threadId)) } label: {
            Label {
                Text(thread.unread ? "mail.row.markRead" : "mail.row.markUnread", bundle: .module)
            } icon: {
                Image(systemName: thread.unread ? "envelope.open" : "envelope.badge")
            }
        }
        .tint(Theme.Colors.accent)
        .accessibilityIdentifier(MailIdentifiers.threadReadPrefix + thread.threadId)
    }

    var more: some View {
        HStack {
            Spacer()
            ProgressView()
            Spacer()
        }
        .onAppear { viewModel.send(.loadMore) }
    }

    var empty: some View {
        Text("mail.empty", bundle: .module)
            .foregroundStyle(Theme.Colors.secondaryText)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, Theme.Spacing.large)
    }

    var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(contextChips, id: \.title) { chip in
                    MailContextChip(title: chip.title, color: chip.color, clear: chip.clear)
                }
                Button { filterOpen = true } label: {
                    Label {
                        Text(hasContext ? "mail.filter.edit" : "mail.filter.add", bundle: .module)
                    } icon: {
                        Image(systemName: "line.3.horizontal.decrease")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier(MailIdentifiers.threadsFilter)
                ForEach(MailListFilter.allCases, id: \.self) { filter in filterChip(filter) }
                ForEach(viewModel.state.mailboxes) { mailbox in mailboxChip(mailbox) }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
        }
    }

    func filterChip(_ filter: MailListFilter) -> some View {
        let selected = viewModel.state.filter == filter
        return Button { viewModel.send(.selectFilter(filter)) } label: { Text(filter.title, bundle: .module) }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(selected ? Theme.Colors.accent : Theme.Colors.secondaryText)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    func mailboxChip(_ mailbox: MailMailboxChip) -> some View {
        let selected = viewModel.state.mailboxId == mailbox.id
        return Button { viewModel.send(.selectMailbox(mailbox.id)) } label: { Text(verbatim: mailbox.name) }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(selected ? Theme.Colors.accent : Theme.Colors.secondaryText)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    func reauthorization(_ notice: MailAccountNotice) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: reauthorizationTitle(notice)).font(.subheadline.weight(.semibold))
                Text("mail.reauth.reason", bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: 0)
            Button { viewModel.send(.open(.openAccount(mailboxId: notice.id))) } label: {
                Text("mail.reauth.open", bundle: .module)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .accessibilityIdentifier(MailIdentifiers.threadsReauth)
        }
        .padding(Theme.Spacing.small + 4)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.card / 2))
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.bottom, Theme.Spacing.small)
    }
}

// MARK: - Private
private extension MailThreadsScreen {

    var dismissButton: some View {
        Button(role: .cancel) { viewModel.send(.dismissFailure) } label: { Text("state.ok", bundle: .module) }
    }

    var actionFailed: Binding<Bool> {
        Binding(get: { viewModel.state.actionFailed }, set: { if !$0 { viewModel.send(.dismissFailure) } })
    }

    var hasContext: Bool {
        viewModel.state.areaId != nil || viewModel.state.projectId != nil
    }

    struct ContextChip {

        let title: String
        let color: String?
        let clear: () -> Void
    }

    /// The chips of the area and project the list is narrowed to; each clears its own.
    var contextChips: [ContextChip] {
        var chips: [ContextChip] = []
        let state = viewModel.state
        if state.areaId != nil {
            let name = state.areaName ?? String(localized: "mail.filter.area", bundle: .module)
            let title = String(format: String(localized: "mail.chip.area", bundle: .module), locale: .current, name)
            chips.append(ContextChip(title: title, color: state.facets.areas.first { $0.id == state.areaId }?.color) {
                viewModel.send(.setArea(nil))
            })
        }
        if state.projectId != nil {
            let name = state.projectName ?? String(localized: "mail.filter.project", bundle: .module)
            let title = String(format: String(localized: "mail.chip.project", bundle: .module), locale: .current, name)
            let color = state.facets.projects.first { $0.id == state.projectId }?.color
            chips.append(ContextChip(title: title, color: color) { viewModel.send(.setProject(nil)) })
        }
        return chips
    }

    func reauthorizationTitle(_ notice: MailAccountNotice) -> String {
        guard let date = MailFormatting.date(notice.since) else {
            let format = String(localized: "mail.reauth.titleNoTime", bundle: .module)
            return String(format: format, locale: .current, notice.name)
        }
        let format = String(localized: "mail.reauth.title", bundle: .module)
        return String(format: format, locale: .current, notice.name, date.formatted(date: .omitted, time: .shortened))
    }
}

private extension MailListFilter {

    var title: LocalizedStringKey {
        switch self {
        case .all: "mail.filter.all"
        case .unread: "mail.filter.unread"
        case .flagged: "mail.filter.flagged"
        }
    }
}

/// An area or a project the list is narrowed to, as a capsule with a color dot and a button that removes it.
private struct MailContextChip: View {

    // MARK: - Dependencies
    let title: String
    let color: String?
    let clear: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small / 2) {
            Circle().fill(Color(hex: color) ?? Theme.Colors.accent).frame(width: 8, height: 8)
            Text(verbatim: title).font(.footnote)
            Button(action: clear) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.Colors.secondaryText)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(removeLabel)
        }
        .padding(.horizontal, Theme.Spacing.small)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: Capsule())
    }

    private var removeLabel: Text {
        Text(verbatim: String(format: String(localized: "mail.chip.remove", bundle: .module), locale: .current, title))
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        MailThreadsScreen(
            viewModel: MailThreadsViewModel(
                model: ScriptedMailThreadsScreenModel(state: PreviewMail.threads),
                router: PreviewMailRouter()
            ),
            title: nil
        )
    }
}

#Preview("Loading") {
    NavigationStack {
        MailThreadsScreen(
            viewModel: MailThreadsViewModel(
                model: ScriptedMailThreadsScreenModel(state: MailThreadsState()),
                router: PreviewMailRouter()
            ),
            title: nil
        )
    }
}
