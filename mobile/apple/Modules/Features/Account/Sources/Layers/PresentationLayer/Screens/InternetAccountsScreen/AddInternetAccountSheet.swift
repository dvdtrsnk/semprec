import CoreKit
import DesignSystem
import SwiftUI

/// The sheet that adds an internet account. It first asks for the provider: iCloud and Other go on to the form that
/// connects them with an address and a password (iCloud with an app-specific password, Other with its IMAP and SMTP
/// servers and, optionally, its CalDAV server); Google and Microsoft sign in in a browser, which this version of the
/// app does not start yet, so they only say so. The server checks the login before it saves anything. The text typed
/// here stays in this view and goes to the shared ViewModel when the form is submitted.
struct AddInternetAccountSheet: View {

    // MARK: - Dependencies
    let state: InternetAccountsState
    let send: (InternetAccountsAction) -> Void

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss
    @State private var oauthNotice = false

    // MARK: - Body
    var body: some View {
        NavigationStack {
            List {
                Section {
                    provider("internetAccounts.add.provider.icloud", badge: "icloud", form: .icloud)
                    oauthProvider("internetAccounts.add.provider.google", badge: "gmail", identifier: "google")
                    oauthProvider("internetAccounts.add.provider.microsoft", badge: "outlook", identifier: "microsoft")
                    provider("internetAccounts.add.provider.other", badge: nil, form: .other)
                }
            }
            .groupedListStyle()
            .navigationTitle(Text("internetAccounts.add.title", bundle: .module))
            .inlineNavigationTitle()
            .navigationDestination(for: InternetPasswordProvider.self) { provider in
                InternetAccountConnectForm(provider: provider, state: state, send: send)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Text("internetAccounts.add.cancel", bundle: .module) }
                }
            }
            .alert(
                Text("internetAccounts.add.oauthLater", bundle: .module),
                isPresented: $oauthNotice,
                actions: {
                    Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
                        .accessibilityIdentifier(AccountIdentifiers.addOauthNotice)
                }
            )
        }
        .accessibilityIdentifier(AccountIdentifiers.addSheet)
        .onDisappear { send(.dismissConnectFailure) }
    }
}

// MARK: - Subviews
private extension AddInternetAccountSheet {

    func provider(_ title: LocalizedStringKey, badge: String?, form: InternetPasswordProvider) -> some View {
        NavigationLink(value: form) {
            label(title, badge: badge, hint: form == .other ? "internetAccounts.add.provider.otherHint" : nil)
        }
        .accessibilityIdentifier(AccountIdentifiers.addProviderPrefix + (form == .icloud ? "icloud" : "other"))
    }

    func oauthProvider(_ title: LocalizedStringKey, badge: String, identifier: String) -> some View {
        Button { oauthNotice = true } label: {
            label(title, badge: badge, hint: nil).contentShape(Rectangle())
        }
        .listRowButton()
        .foregroundStyle(.primary)
        .accessibilityIdentifier(AccountIdentifiers.addProviderPrefix + identifier)
    }

    func label(_ title: LocalizedStringKey, badge: String?, hint: LocalizedStringKey?) -> some View {
        HStack(spacing: Theme.Spacing.small + 4) {
            InternetAccountProviderBadge(provider: badge, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title, bundle: .module)
                if let hint {
                    Text(hint, bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Preview
#Preview {
    AddInternetAccountSheet(state: InternetAccountsState(phase: .content), send: { _ in })
}
