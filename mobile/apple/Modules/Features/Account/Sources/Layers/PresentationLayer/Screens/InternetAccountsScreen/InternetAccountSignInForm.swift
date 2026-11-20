import CoreKit
import DesignSystem
import SwiftUI

/// The page of the add sheet that signs a Google or Microsoft account in in a browser. Mail always syncs, because the
/// account is connected through its mail; Calendars is on unless the person switches it off here. The browser sheet
/// opens over this page once the server has given the provider's page, and the add sheet closes when the account was
/// added.
struct InternetAccountSignInForm: View {

    // MARK: - Dependencies
    let provider: InternetOAuthProvider
    let state: InternetAccountsState
    let signIn: (InternetOAuthProvider, Bool, BrowserSignIn) -> Void

    // MARK: - State
    @Environment(\.webAuthenticationSession)
    private var webAuthenticationSession
    @State private var calendars = true

    // MARK: - Body
    var body: some View {
        Form {
            Section {
                Toggle(isOn: .constant(true)) { Text(verbatim: InternetServiceStatusLabel.name(.mail)) }
                    .disabled(true)
                Toggle(isOn: $calendars) { Text(verbatim: InternetServiceStatusLabel.name(.calendars)) }
                    .accessibilityIdentifier(AccountIdentifiers.addSignInCalendars)
            } footer: {
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    Text("internetAccounts.add.signIn.hint", bundle: .module)
                    if let failure = state.connectFailure {
                        Text(failure.message, bundle: .module).foregroundStyle(Theme.Colors.destructive)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(Text(title, bundle: .module))
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    signIn(provider, calendars, BrowserSignIn(webAuthenticationSession))
                } label: {
                    if state.connecting {
                        ProgressView()
                    } else {
                        Text("internetAccounts.add.signIn.submit", bundle: .module)
                    }
                }
                .disabled(state.connecting)
                .accessibilityIdentifier(AccountIdentifiers.addSignInSubmit)
            }
        }
    }
}

// MARK: - Subviews
private extension InternetAccountSignInForm {

    var title: LocalizedStringKey {
        switch provider {
        case .google: "internetAccounts.add.provider.google"
        case .microsoft: "internetAccounts.add.provider.microsoft"
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        InternetAccountSignInForm(
            provider: .google,
            state: InternetAccountsState(phase: .content, connectFailure: .declined),
            signIn: { _, _, _ in }
        )
    }
}
