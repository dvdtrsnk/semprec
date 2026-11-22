import CoreKit
import DesignSystem
import SwiftUI

/// The field that adds a value to one list of the signals. The text lives in the shared state; the field keeps a copy
/// while the person types. The shared text arrives a moment after each keystroke, so a shared text the field sent
/// itself is only acknowledged; any other one (an added value empties the field) replaces the copy.
struct MailSignalInputRow: View {

    // MARK: - Dependencies
    let field: MailSignalField
    let sharedText: String
    let send: (ProjectMailSignalsAction) -> Void

    // MARK: - State
    @State private var text = ""
    /// What the field sent and the shared state has not shown yet, oldest first.
    @State private var unacknowledged: [String] = []

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            TextField(text: $text) { Text(placeholder, bundle: .module) }
                .textInput(kind)
                .onSubmit { send(.add(field)) }
                .onChange(of: text) { _, new in
                    guard new != sharedText else { return }
                    unacknowledged.append(new)
                    send(.editInput(field, text: new))
                }
                .accessibilityIdentifier(MailIdentifiers.signalsInputPrefix + field.identifier)
            Button { send(.add(field)) } label: {
                Image(systemName: "plus.circle.fill").imageScale(.large)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text("mail.signals.add", bundle: .module))
            .accessibilityIdentifier(MailIdentifiers.signalsAddPrefix + field.identifier)
        }
        .onAppear { text = sharedText }
        .onChange(of: sharedText) { _, new in
            if let sent = unacknowledged.firstIndex(of: new) {
                unacknowledged.removeFirst(sent + 1)
            } else {
                unacknowledged = []
                text = new
            }
        }
    }
}

// MARK: - Private
private extension MailSignalInputRow {

    var placeholder: LocalizedStringKey {
        switch field {
        case .domains: "mail.signals.domains.placeholder"
        case .addresses: "mail.signals.addresses.placeholder"
        case .keywords: "mail.signals.keywords.placeholder"
        }
    }

    var kind: TextInputKind {
        switch field {
        case .domains: .url
        case .addresses: .email
        case .keywords: .plain
        }
    }
}

// MARK: - Identifier
extension MailSignalField {

    /// The segment of the field in the accessibility identifiers of the signals screen.
    var identifier: String {
        switch self {
        case .domains: "domains"
        case .addresses: "addresses"
        case .keywords: "keywords"
        }
    }
}
