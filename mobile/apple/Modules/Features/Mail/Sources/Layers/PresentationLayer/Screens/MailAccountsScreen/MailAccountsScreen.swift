import CoreKit
import DesignSystem
import SwiftUI

/// The connected accounts. A row opens the account; the add button opens the form that connects an iCloud or another
/// IMAP mailbox. Gmail and Outlook sign in in a browser, which this app does not start.
struct MailAccountsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: MailAccountsViewModel

    // MARK: - State
    @State private var adding = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> MailAccountsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("mail.accounts.title", bundle: .module))
            .sheet(isPresented: $adding) {
                MailAddAccountSheet(state: viewModel.state, send: viewModel.send)
            }
            .onChange(of: viewModel.connections) { adding = false }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(MailIdentifiers.accountsScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension MailAccountsScreen {

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
                    Label { Text("mail.accounts.add", bundle: .module) } icon: { Image(systemName: "plus") }
                }
                .listRowButton()
                .accessibilityIdentifier(MailIdentifiers.addAccount)
            } footer: {
                Text("mail.accounts.footer", bundle: .module)
            }
        }
        .groupedListStyle()
        .refreshable { await viewModel.refresh() }
    }

    func row(_ account: MailAccountItem) -> some View {
        Button { viewModel.send(.open(mailboxId: account.id)) } label: {
            HStack(spacing: Theme.Spacing.small + 4) {
                MailProviderBadge(provider: account.provider)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: account.name).foregroundStyle(.primary)
                    if let address = account.address {
                        Text(verbatim: address).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                Spacer(minLength: 0)
                MailStatusLabel(status: account.status)
            }
            .foregroundStyle(.primary)
            .contentShape(Rectangle())
        }
        .listRowButton()
        .accessibilityIdentifier(MailIdentifiers.accountRowPrefix + account.id)
    }
}

/// The letter and color of a provider, as the avatar of its accounts.
struct MailProviderBadge: View {

    // MARK: - Dependencies
    let provider: String?
    var size: CGFloat = 36

    // MARK: - Body
    var body: some View {
        Text(verbatim: letter)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color, in: Circle())
            .accessibilityHidden(true)
    }

    // MARK: - Private
    private var letter: String {
        switch provider {
        case "gmail": "G"
        case "outlook": "O"
        case "icloud": "i"
        default: "@"
        }
    }

    private var color: Color {
        switch provider {
        case "gmail": .red
        case "outlook": .blue
        case "icloud": .cyan
        default: .gray
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        MailAccountsScreen(
            viewModel: MailAccountsViewModel(
                model: ScriptedMailAccountsScreenModel(state: PreviewMail.accounts),
                router: PreviewMailRouter()
            )
        )
    }
}
