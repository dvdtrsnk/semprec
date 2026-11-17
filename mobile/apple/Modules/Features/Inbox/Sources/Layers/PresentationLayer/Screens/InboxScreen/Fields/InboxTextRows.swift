import CoreKit
import DesignSystem
import SwiftUI

/// A one-line text. What is typed stays here until the person submits it or leaves the field, and is then sent.
struct InboxTextRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let focus: FocusState<String?>.Binding
    let send: (InboxAction) -> Void

    // MARK: - Properties
    @State private var draft: String

    // MARK: - Init
    init(cardId: String, field: InboxField, focus: FocusState<String?>.Binding, send: @escaping (InboxAction) -> Void) {
        self.cardId = cardId
        self.field = field
        self.focus = focus
        self.send = send
        _draft = State(initialValue: field.text)
    }

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            TextField(field.hint ?? "", text: $draft)
                .multilineTextAlignment(.trailing)
                .textInput(kind)
                .focused(focus, equals: field.key)
                .onSubmit(commit)
        }
        .onChange(of: focus.wrappedValue) { old, new in
            if old == field.key, new != field.key { commit() }
        }
        .onChange(of: field.text) { _, text in
            if focus.wrappedValue != field.key { draft = text }
        }
    }
}

// MARK: - Private
private extension InboxTextRow {

    var kind: TextInputKind {
        switch field.keyboard {
        case .email: .email
        case .url: .url
        case .text, .tel: .plain
        }
    }

    func commit() {
        guard draft != field.text else { return }
        send(.setText(cardId: cardId, key: field.key, text: draft))
    }
}

/// A longer text in Markdown, which the person writes under its label.
struct InboxAreaRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let focus: FocusState<String?>.Binding
    let send: (InboxAction) -> Void

    // MARK: - Properties
    @State private var draft: String

    // MARK: - Init
    init(cardId: String, field: InboxField, focus: FocusState<String?>.Binding, send: @escaping (InboxAction) -> Void) {
        self.cardId = cardId
        self.field = field
        self.focus = focus
        self.send = send
        _draft = State(initialValue: field.text)
    }

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(field.title)
                    .font(.footnote)
                    .foregroundStyle(field.missing ? Theme.Colors.destructive : Theme.Colors.secondaryText)
                if field.edited {
                    Circle().fill(Theme.Colors.accent).frame(width: 6, height: 6)
                        .accessibilityLabel(Text("inbox.edited", bundle: .module))
                }
            }
            TextEditor(text: $draft)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 96)
                .focused(focus, equals: field.key)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .onChange(of: focus.wrappedValue) { old, new in
            if old == field.key, new != field.key { commit() }
        }
        .onChange(of: field.text) { _, text in
            if focus.wrappedValue != field.key { draft = text }
        }
    }

    // MARK: - Private
    private func commit() {
        guard draft != field.text else { return }
        send(.setText(cardId: cardId, key: field.key, text: draft))
    }
}

/// A secret, such as the key of an MCP server. It is shown as dots, kept by the shared ViewModel only until the card is
/// approved, and never written to the proposal.
struct InboxSecretRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let focus: FocusState<String?>.Binding
    let send: (InboxAction) -> Void

    // MARK: - Properties
    @State private var draft = ""

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            HStack(spacing: 6) {
                SecureField(field.hint ?? "", text: $draft)
                    .multilineTextAlignment(.trailing)
                    .textInput(.plain)
                    .focused(focus, equals: field.key)
                    .onSubmit(commit)
                if field.flag {
                    Image(systemName: "lock.fill").foregroundStyle(Theme.Colors.secondaryText)
                        .accessibilityHidden(true)
                }
            }
        }
        .onChange(of: focus.wrappedValue) { old, new in
            if old == field.key, new != field.key { commit() }
        }
    }

    // MARK: - Private
    private func commit() {
        guard !draft.isEmpty || field.flag else { return }
        send(.setSecret(cardId: cardId, text: draft))
    }
}
