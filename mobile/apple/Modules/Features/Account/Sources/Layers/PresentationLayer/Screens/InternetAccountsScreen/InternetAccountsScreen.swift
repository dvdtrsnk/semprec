import CoreKit
import DesignSystem
import SwiftUI

/// The internet accounts, each with what its Mail and Calendars are doing. A row opens the account; the add button
/// opens the sheet that asks for the provider and then connects an iCloud or another account with a password.
struct InternetAccountsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: InternetAccountsViewModel

    // MARK: - State
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
                AddInternetAccountSheet(state: viewModel.state, send: viewModel.send)
            }
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
                ForEach(viewModel.state.accounts) { account in row(account) }
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
                                mail: .ok, calendars: .pending
                            ),
                            InternetAccountItem(
                                id: "a2", name: "Work", address: "david@firma.cz", provider: "imap",
                                mail: .needsReauthorization, calendars: .off
                            )
                        ]
                    )
                ),
                router: PreviewAccountRouter()
            )
        )
    }
}
