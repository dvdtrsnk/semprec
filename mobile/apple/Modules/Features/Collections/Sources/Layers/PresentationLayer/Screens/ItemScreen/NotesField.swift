import CoreKit
import DesignSystem
import SwiftUI

/// A long text property written in place, such as the notes of a film: it is saved when the person leaves the field.
struct NotesField: View {

    // MARK: - Dependencies
    let field: FieldView
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var draft = ""
    @FocusState private var focused: Bool

    // MARK: - Body
    var body: some View {
        TextField(text: $draft, axis: .vertical) { Text("item.media.notes.placeholder", bundle: .module) }
            .lineLimit(3...12)
            .focused($focused)
            .disabled(!field.editable)
            .accessibilityIdentifier(CollectionsIdentifiers.fieldPrefix + field.propertyKey)
            .onAppear { draft = saved }
            .onChange(of: field.content) { _, _ in if !focused { draft = saved } }
            .onChange(of: focused) { _, isFocused in if !isFocused, draft != saved { save() } }
    }
}

// MARK: - Private
private extension NotesField {

    var saved: String {
        if case .text(let text) = field.content { return text }
        return ""
    }

    func save() {
        send(.edit(.setText(propertyKey: field.propertyKey, text: draft)))
    }
}
