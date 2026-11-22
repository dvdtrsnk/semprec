import CoreKit
import DesignSystem
import SwiftUI

/// The internet accounts, each with what its Mail and Calendars are doing. A row opens the account; an account whose
/// sign-in a service no longer accepts has a row below it that signs it in again, in a browser for Google and
/// Microsoft and in a sheet that asks for the password otherwise. The add button opens the sheet that asks for the
/// provider and then connects an iCloud or another account with a password, or signs a Google or Microsoft account in
/// in a browser; a connect refused because the account is already connected offers to open that account.
struct InternetAccountsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: InternetAccountsViewModel

    // MARK: - State
    @Environment(\.webAuthenticationSession)
    private var webAuthenticationSession
    @State private var adding = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> InternetAccountsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("internetAccounts.title", bundle: .module))
            .sheet(isPresented: $adding) {
                AddInternetAccountSheet(
                    state: viewModel.state,
                    send: viewModel.send,
                    signIn: viewModel.signIn,
                    openExisting: openExisting
                )
            }
            .sheet(isPresented: passwordSignInShown) {
                if let signIn = viewModel.state.passwordSignIn {
                    PasswordSignInSheet(signIn: signIn) { viewModel.send(.passwordSignIn($0)) }
                }
            }
            .alert(
                Text("profile.failed.title", bundle: .module),
                isPresented: signInFailed,
                actions: {
                    Button(role: .cancel) { viewModel.send(.dismissSignInFailure) } label: {
                        Text("common.ok", bundle: .module)
                    }
                },
                message: { Text(viewModel.state.signInFailure?.message ?? "", bundle: .module) }
            )
            .onChange(of: viewModel.connections) { adding = false }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AccountIdentifiers.internetAccountsScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension InternetAccountsScreen {

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
                ForEach(viewModel.state.accounts) { account in
                    row(account)
                    if account.canSignInAgain { signInAgain(account) }
                }
                Button { adding = true } label: {
                    Label { Text("internetAccounts.add", bundle: .module) } icon: { Image(systemName: "plus") }
                }
                .listRowButton()
                .accessibilityIdentifier(AccountIdentifiers.internetAccountsAdd)
            } footer: {
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    if viewModel.state.accounts.isEmpty {
                        Text("internetAccounts.empty", bundle: .module)
                    }
                    Text("internetAccounts.footer", bundle: .module)
                }
            }
        }
        .groupedListStyle()
        .refreshable { await viewModel.refresh() }
    }

    func row(_ account: InternetAccountItem) -> some View {
        Button { viewModel.send(.open(accountId: account.id)) } label: {
            HStack(spacing: Theme.Spacing.small + 4) {
                InternetAccountProviderBadge(provider: account.provider)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: account.name).foregroundStyle(.primary)
                    if let address = account.address {
                        Text(verbatim: address).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                    }
                    HStack(spacing: Theme.Spacing.medium) {
                        InternetServiceStatusLabel(service: .mail, status: account.mail)
                        InternetServiceStatusLabel(service: .calendars, status: account.calendars)
                    }
                    if let indexing = viewModel.state.historyIndexing, indexing.accountId == account.id {
                        historyIndexing(indexing)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .foregroundStyle(.primary)
            .contentShape(Rectangle())
        }
        .listRowButton()
        .accessibilityIdentifier(AccountIdentifiers.internetAccountRowPrefix + account.id)
    }

    /// What the history indexing of a just connected account has done, below its statuses.
    func historyIndexing(_ indexing: InternetHistoryIndexing) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            ProgressView().controlSize(.mini)
            Text(verbatim: Self.historyText(indexing))
                .font(.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(AccountIdentifiers.internetAccountHistoryPrefix + indexing.accountId)
    }

    func signInAgain(_ account: InternetAccountItem) -> some View {
        Button {
            viewModel.signInAgain(accountId: account.id, browser: BrowserSignIn(webAuthenticationSession))
        } label: {
            HStack {
                Label {
                    Text("internetAccount.signInAgain", bundle: .module)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                if viewModel.state.signingIn { ProgressView() }
            }
        }
        .disabled(viewModel.state.signingIn)
        .listRowButton()
        .accessibilityIdentifier(AccountIdentifiers.internetAccountSignInAgainPrefix + account.id)
    }
}

// MARK: - Private
private extension InternetAccountsScreen {

    var passwordSignInShown: Binding<Bool> {
        Binding(
            get: { viewModel.state.passwordSignIn != nil },
            set: { if !$0, viewModel.state.passwordSignIn != nil { viewModel.send(.passwordSignIn(.cancel)) } }
        )
    }

    var signInFailed: Binding<Bool> {
        Binding(
            get: { viewModel.state.signInFailure != nil },
            set: { if !$0 { viewModel.send(.dismissSignInFailure) } }
        )
    }

    static func historyText(_ indexing: InternetHistoryIndexing) -> String {
        guard indexing.foldersTotal > 0 else {
            return String(localized: "internetAccounts.history.waiting", bundle: .module)
        }
        let format = String(localized: "internetAccounts.history.progress", bundle: .module)
        return String(
            format: format, locale: .current, indexing.foldersDone, indexing.foldersTotal, indexing.messagesUploaded
        )
    }

    /// Closes the add sheet and opens the account that already holds the address.
    func openExisting() {
        adding = false
        viewModel.send(.openExisting)
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        InternetAccountsScreen(
            viewModel: InternetAccountsViewModel(
                model: ScriptedInternetAccountsScreenModel(
                    state: InternetAccountsState(
                        phase: .content,
                        accounts: [
                            InternetAccountItem(
                                id: "a1", name: "iCloud", address: "david@icloud.com", provider: "icloud",
                                mail: .syncing, calendars: .pending
                            ),
                            InternetAccountItem(
                                id: "a2", name: "Work", address: "david@firma.cz", provider: "generic",
                                mail: .needsReauthorization, calendars: .off, canSignInAgain: true
                            )
                        ],
                        historyIndexing: InternetHistoryIndexing(
                            accountId: "a1", foldersDone: 2, foldersTotal: 5, messagesUploaded: 1_840
                        )
                    )
                ),
                router: PreviewAccountRouter()
            )
        )
    }
}
