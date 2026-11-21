import CoreKit
import DesignSystem
import SwiftUI

/// The sheet that adds an internet account. It first asks for the provider: iCloud and Other go on to the form that
/// connects them with an address and a password (iCloud with an app-specific password, Other with its IMAP and SMTP
/// servers and, optionally, its CalDAV server); Google and Microsoft go on to the page that asks whether Calendars
/// syncs too and signs them in in a browser. The server checks the login before it saves anything. The text typed
/// here stays in this view and goes to the shared ViewModel when the form is submitted.
struct AddInternetAccountSheet: View {

    // MARK: - Dependencies
    let state: InternetAccountsState
    let send: (InternetAccountsAction) -> Void
    let signIn: (InternetOAuthProvider, Bool, BrowserSignIn) -> Void
    /// Closes the sheet and opens the listed account that already holds the address of a refused connect.
    let openExisting: () -> Void

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            List {
                Section {
                    provider("internetAccounts.add.provider.icloud", badge: "icloud", form: .icloud)
                    oauthProvider("internetAccounts.add.provider.google", badge: "gmail", provider: .google)
                    oauthProvider("internetAccounts.add.provider.microsoft", badge: "outlook", provider: .microsoft)
                    provider("internetAccounts.add.provider.other", badge: nil, form: .other)
                }
            }
            .groupedListStyle()
            .navigationTitle(Text("internetAccounts.add.title", bundle: .module))
            .inlineNavigationTitle()
            .navigationDestination(for: InternetPasswordProvider.self) { provider in
                InternetAccountConnectForm(provider: provider, state: state, send: send, openExisting: openExisting)
            }
            .navigationDestination(for: InternetOAuthProvider.self) { provider in
                InternetAccountSignInForm(provider: provider, state: state, signIn: signIn)
            }
            .toolbar {
                PlainToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Text("internetAccounts.add.cancel", bundle: .module) }
                }
            }
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

    func oauthProvider(_ title: LocalizedStringKey, badge: String, provider: InternetOAuthProvider) -> some View {
        NavigationLink(value: provider) {
            label(title, badge: badge, hint: nil)
        }
        .accessibilityIdentifier(AccountIdentifiers.addProviderPrefix + (provider == .google ? "google" : "microsoft"))
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
    AddInternetAccountSheet(
        state: InternetAccountsState(phase: .content),
        send: { _ in },
        signIn: { _, _, _ in },
        openExisting: {}
    )
}
