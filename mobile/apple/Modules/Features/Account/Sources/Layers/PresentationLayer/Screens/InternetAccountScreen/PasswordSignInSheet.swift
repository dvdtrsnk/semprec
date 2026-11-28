import CoreKit
import DesignSystem
import SwiftUI

/// The sheet that signs an iCloud or another password account in again: its password (an app-specific one for
/// iCloud) and, optionally, another user name; left empty, the user name the server has is kept. The server checks
/// the login before it keeps it, so the sheet stays open with the reason when it is refused and closes when it is
/// accepted. The text typed here stays in this view and goes to the shared ViewModel when the form is submitted.
struct PasswordSignInSheet: View {

    // MARK: - Dependencies
    let signIn: InternetPasswordSignIn
    let send: (InternetPasswordSignInStep) -> Void

    // MARK: - State
    @State private var password = ""
    @State private var username = ""

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField(text: $password) { Text(passwordLabel, bundle: .module) }
                        .accessibilityIdentifier(AccountIdentifiers.passwordSignInPassword)
                    TextField(text: $username, prompt: usernamePrompt) {
                        Text("internetAccount.passwordSignIn.username", bundle: .module)
                    }
                    .textInput(.email)
                    .accessibilityIdentifier(AccountIdentifiers.passwordSignInUsername)
                } header: {
                    if let address = signIn.address { Text(verbatim: address) }
                } footer: {
                    footer
                }
            }
            .formStyle(.grouped)
            .navigationTitle(Text("internetAccount.signInAgain", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                PlainToolbarItem(placement: .cancellationAction) {
                    Button { send(.cancel) } label: { Text("internetAccounts.add.cancel", bundle: .module) }
                        .disabled(signIn.submitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { send(.submit(password: password, username: username)) } label: {
                        if signIn.submitting {
                            ProgressView()
                        } else {
                            Text("internetAccounts.add.signIn.submit", bundle: .module)
                        }
                    }
                    .disabled(signIn.submitting)
                    .accessibilityIdentifier(AccountIdentifiers.passwordSignInSubmit)
                }
            }
        }
        .interactiveDismissDisabled(signIn.submitting)
        .accessibilityIdentifier(AccountIdentifiers.passwordSignInSheet)
    }
}

// MARK: - Subviews
private extension PasswordSignInSheet {

    var passwordLabel: LocalizedStringKey {
        signIn.icloud ? "internetAccounts.add.appPassword" : "internetAccounts.add.password"
    }

    var usernamePrompt: Text? {
        signIn.address.map { Text(verbatim: $0) }
    }

    var footer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text("internetAccount.passwordSignIn.hint", bundle: .module)
            if signIn.icloud { Text("internetAccounts.add.icloudHint", bundle: .module) }
            if let failure = signIn.failure {
                Text(failure.message).foregroundStyle(Theme.Colors.destructive)
            }
        }
    }
}

// MARK: - Preview
#Preview {
    PasswordSignInSheet(
        signIn: InternetPasswordSignIn(
            accountId: "a1", address: "david@icloud.com", icloud: true, failure: .appPasswordRequired
        ),
        send: { _ in }
    )
}
