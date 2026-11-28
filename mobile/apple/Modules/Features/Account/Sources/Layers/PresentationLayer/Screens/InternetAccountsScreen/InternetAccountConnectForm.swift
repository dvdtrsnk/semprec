import CoreKit
import DesignSystem
import SwiftUI

/// The form that connects an account with an address and a password: iCloud with an app-specific password, or
/// another account with its IMAP and SMTP servers and, when its provider names one, its CalDAV server. The CalDAV
/// server is sent only when it is filled in. A connect refused because the address is already connected offers to
/// open that account.
struct InternetAccountConnectForm: View {

    // MARK: - Dependencies
    let provider: InternetPasswordProvider
    let state: InternetAccountsState
    let send: (InternetAccountsAction) -> Void
    let openExisting: () -> Void

    // MARK: - State
    @State private var address = ""
    @State private var password = ""
    @State private var imapHost = ""
    @State private var smtpHost = ""
    @State private var caldavUrl = ""

    // MARK: - Body
    var body: some View {
        Form {
            Section {
                TextField(text: $address) { Text("internetAccounts.add.address", bundle: .module) }
                    .textInput(.email)
                    .accessibilityIdentifier(AccountIdentifiers.addAddress)
                SecureField(text: $password) { Text(passwordLabel, bundle: .module) }
                    .accessibilityIdentifier(AccountIdentifiers.addPassword)
                if provider == .other {
                    TextField(text: $imapHost) { Text("internetAccounts.add.imapServer", bundle: .module) }
                        .textInput(.url)
                        .accessibilityIdentifier(AccountIdentifiers.addImap)
                    TextField(text: $smtpHost) { Text("internetAccounts.add.smtpServer", bundle: .module) }
                        .textInput(.url)
                        .accessibilityIdentifier(AccountIdentifiers.addSmtp)
                    TextField(text: $caldavUrl) { Text("internetAccounts.add.caldavServer", bundle: .module) }
                        .textInput(.url)
                        .accessibilityIdentifier(AccountIdentifiers.addCaldav)
                }
            } footer: {
                footer
            }
            if state.existingAccountId != nil {
                Section {
                    Button(action: openExisting) { Text("internetAccounts.add.openExisting", bundle: .module) }
                        .accessibilityIdentifier(AccountIdentifiers.addOpenExisting)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(Text(title, bundle: .module))
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(action: submit) {
                    if state.connecting {
                        ProgressView()
                    } else {
                        Text("internetAccounts.add.submit", bundle: .module)
                    }
                }
                .disabled(state.connecting)
                .accessibilityIdentifier(AccountIdentifiers.addSubmit)
            }
        }
    }
}

// MARK: - Subviews
private extension InternetAccountConnectForm {

    var title: LocalizedStringKey {
        switch provider {
        case .icloud: "internetAccounts.add.provider.icloud"
        case .other: "internetAccounts.add.provider.other"
        }
    }

    var passwordLabel: LocalizedStringKey {
        switch provider {
        case .icloud: "internetAccounts.add.appPassword"
        case .other: "internetAccounts.add.password"
        }
    }

    @ViewBuilder var footer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            switch provider {
            case .icloud:
                Text("internetAccounts.add.icloudHint", bundle: .module)
            case .other:
                Text("internetAccounts.add.otherHint", bundle: .module)
                Text("internetAccounts.add.caldavHint", bundle: .module)
            }
            if let failure = state.connectFailure {
                Text(failure.message).foregroundStyle(Theme.Colors.destructive)
            }
        }
    }

    func submit() {
        send(
            .connect(
                provider: provider,
                address: address,
                password: password,
                imapHost: imapHost,
                smtpHost: smtpHost,
                caldavUrl: caldavUrl
            )
        )
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        InternetAccountConnectForm(
            provider: .other,
            state: InternetAccountsState(phase: .content, connectFailure: .alreadyConnected, existingAccountId: "a1"),
            send: { _ in },
            openExisting: {}
        )
    }
}
