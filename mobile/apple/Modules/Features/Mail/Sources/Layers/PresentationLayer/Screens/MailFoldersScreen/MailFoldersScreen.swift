import CoreKit
import DesignSystem
import SwiftUI

/// The mailboxes: the smart boxes with their counts, then every account with its folders. Gmail labels show as folders.
struct MailFoldersScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: MailFoldersViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> MailFoldersViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("mail.folders.title", bundle: .module))
            .toolbar {
                PlainToolbarItem(placement: .primaryAction) {
                    Button { viewModel.send(.compose) } label: {
                        Label { Text("mail.compose", bundle: .module) } icon: { Image(systemName: "square.and.pencil") }
                    }
                    .accessibilityIdentifier(MailIdentifiers.threadsCompose)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(MailIdentifiers.foldersScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension MailFoldersScreen {

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
                smart("inbox", "mail.folders.inbox", "tray.full", .inbox, viewModel.state.unreadInbox)
                smart("flagged", "mail.folders.flagged", "flag", .flagged, viewModel.state.flagged)
                smart("semp", "mail.folders.semp", "bubble.left", .sempDrafts, viewModel.state.sempDrafts)
            }
            ForEach(viewModel.state.accounts) { account in
                Section {
                    if !account.collapsed { folders(of: account) }
                } header: {
                    accountHeader(account)
                }
            }
            Section {
                Button { viewModel.send(.openAccounts) } label: {
                    Label {
                        Text("mail.folders.manage", bundle: .module)
                    } icon: {
                        Image(systemName: "person.crop.circle")
                    }
                }
                .listRowButton()
                .accessibilityIdentifier(MailIdentifiers.foldersAccounts)
            } footer: {
                Text("mail.folders.footer", bundle: .module)
            }
        }
        .groupedListStyle()
        .refreshable { await viewModel.refresh() }
    }

    func smart(
        _ id: String,
        _ title: LocalizedStringKey,
        _ symbol: String,
        _ box: MailListBox,
        _ count: Int
    ) -> some View {
        Button { viewModel.send(.openBox(box)) } label: {
            HStack {
                Label { Text(title, bundle: .module) } icon: { Image(systemName: symbol) }
                Spacer(minLength: 0)
                if count > 0 { Text(verbatim: String(count)).foregroundStyle(Theme.Colors.secondaryText) }
            }
            .foregroundStyle(.primary)
            .contentShape(Rectangle())
        }
        .listRowButton()
        .accessibilityIdentifier(MailIdentifiers.smartPrefix + id)
    }

    @ViewBuilder
    func folders(of account: MailFolderAccount) -> some View {
        if account.foldersFailed {
            Text("mail.folders.failed", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
        }
        ForEach(account.folders) { folder in
            Button { viewModel.send(.openFolder(mailboxId: account.id, folderId: folder.id)) } label: {
                HStack {
                    Label {
                        Text(verbatim: folder.name)
                    } icon: {
                        Image(systemName: MailFormatting.folderSymbol(folder.specialPurpose))
                    }
                    Spacer(minLength: 0)
                    if folder.unreadCount > 0 {
                        Text(verbatim: String(folder.unreadCount)).foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                .foregroundStyle(.primary)
                .contentShape(Rectangle())
            }
            .listRowButton()
            .accessibilityIdentifier(MailIdentifiers.folderPrefix + folder.id)
        }
    }

    func accountHeader(_ account: MailFolderAccount) -> some View {
        Button { viewModel.send(.toggleAccount(mailboxId: account.id)) } label: {
            HStack(spacing: Theme.Spacing.small) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: account.name).font(.headline).foregroundStyle(.primary)
                    if let address = account.address {
                        Text(verbatim: address).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                Spacer(minLength: 0)
                MailStatusLabel(status: account.status)
                Image(systemName: account.collapsed ? "chevron.right" : "chevron.down")
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .textCase(nil)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(MailIdentifiers.accountTogglePrefix + account.id)
    }
}

/// What a mailbox is doing, as a colored dot and a word.
struct MailStatusLabel: View {

    // MARK: - Dependencies
    let status: MailAccountStatus

    // MARK: - Body
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(title, bundle: .module).font(.caption.weight(.medium)).foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Private
    private var color: Color {
        switch status {
        case .ok: .green
        case .syncing: .orange
        case .error, .needsReauthorization: Theme.Colors.destructive
        }
    }

    private var title: LocalizedStringKey {
        switch status {
        case .ok: "mail.status.ok"
        case .syncing: "mail.status.syncing"
        case .error: "mail.status.error"
        case .needsReauthorization: "mail.status.reauth"
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        MailFoldersScreen(
            viewModel: MailFoldersViewModel(
                model: ScriptedMailFoldersScreenModel(state: PreviewMail.folders),
                router: PreviewMailRouter()
            )
        )
    }
}
