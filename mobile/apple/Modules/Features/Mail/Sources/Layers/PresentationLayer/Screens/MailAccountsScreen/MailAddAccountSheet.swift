import CoreKit
import DesignSystem
import SwiftUI

/// The form that connects a mailbox with an address and a password: iCloud with an app password, or another IMAP
/// account with its servers. The server checks the login before it saves anything. The text typed here stays in this
/// view and goes to the shared ViewModel when the form is submitted.
struct MailAddAccountSheet: View {

    // MARK: - Dependencies
    let state: MailAccountsState
    let send: (MailAccountsAction) -> Void

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss
    @State private var kind: MailConnectKind = .icloud
    @State private var address = ""
    @State private var password = ""
    @State private var imapHost = ""
    @State private var smtpHost = ""

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(selection: $kind) {
                        Text("mail.accounts.add.icloud", bundle: .module).tag(MailConnectKind.icloud)
                        Text("mail.accounts.add.imap", bundle: .module).tag(MailConnectKind.generic)
                    } label: {
                        Text("mail.accounts.add.provider", bundle: .module)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                Section {
                    TextField(text: $address) { Text("mail.accounts.add.address", bundle: .module) }
                        .textInput(.email)
                        .accessibilityIdentifier(MailIdentifiers.addAddress)
                    SecureField(text: $password) { Text("mail.accounts.add.password", bundle: .module) }
                        .accessibilityIdentifier(MailIdentifiers.addPassword)
                    if kind == .generic {
                        TextField(text: $imapHost) { Text("mail.accounts.add.imapServer", bundle: .module) }
                            .textInput(.url)
                            .accessibilityIdentifier(MailIdentifiers.addImap)
                        TextField(text: $smtpHost) { Text("mail.accounts.add.smtpServer", bundle: .module) }
                            .textInput(.url)
                            .accessibilityIdentifier(MailIdentifiers.addSmtp)
                    }
                } footer: {
                    footer
                }
            }
            .formStyle(.grouped)
            .navigationTitle(Text("mail.accounts.add", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Text("mail.accounts.add.cancel", bundle: .module) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: submit) {
                        if state.connecting {
                            ProgressView()
                        } else {
                            Text("mail.accounts.add.submit", bundle: .module)
                        }
                    }
                    .disabled(state.connecting)
                    .accessibilityIdentifier(MailIdentifiers.addSubmit)
                }
            }
        }
        .accessibilityIdentifier(MailIdentifiers.addSheet)
        .onDisappear { send(.dismissConnectFailure) }
    }
}

// MARK: - Subviews
private extension MailAddAccountSheet {

    @ViewBuilder var footer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(kind == .icloud ? "mail.accounts.add.icloudHint" : "mail.accounts.add.imapHint", bundle: .module)
            Text("mail.accounts.add.browserNote", bundle: .module)
            if let failure = state.connectFailure {
                Text(failure.message, bundle: .module).foregroundStyle(Theme.Colors.destructive)
            }
        }
    }

    func submit() {
        send(.connect(kind: kind, address: address, password: password, imapHost: imapHost, smtpHost: smtpHost))
    }
}

private extension MailConnectFailure {

    var message: LocalizedStringKey {
        switch self {
        case .invalidInput: "mail.accounts.add.error.invalid"
        case .refused: "mail.accounts.add.error.refused"
        case .unavailable: "mail.accounts.add.error.unavailable"
        case .unexpected: "mail.accounts.add.error.unexpected"
        }
    }
}
