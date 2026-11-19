import SwiftUI

/// What the link dialog edits: the existing address when the cursor is in a link.
struct NoteLinkDraft: Identifiable, Equatable {

    let id = 0
    var address: String
    let isExisting: Bool
}

/// The dialog that adds or edits a link: one "https://" field; an existing link can also be removed.
struct NoteLinkDialog: ViewModifier {

    // MARK: - Dependencies
    @Binding var draft: NoteLinkDraft?
    let onSave: (String?) -> Void

    // MARK: - Body
    func body(content: Content) -> some View {
        content.alert(
            Text(draft?.isExisting == true ? "noteEditor.link.edit" : "noteEditor.link.add", bundle: .module),
            isPresented: Binding(get: { draft != nil }, set: { if !$0 { draft = nil } })
        ) {
            TextField(text: Binding(get: { draft?.address ?? "" }, set: { draft?.address = $0 })) {
                Text(verbatim: "https://")
            }
            .autocorrectionDisabled()
            .accessibilityIdentifier(NoteEditorIdentifiers.linkAddress)
            Button {
                let address = draft?.address.trimmingCharacters(in: .whitespaces) ?? ""
                if !address.isEmpty { onSave(address) }
            } label: {
                Text("noteEditor.link.save", bundle: .module)
            }
            if draft?.isExisting == true {
                Button(role: .destructive) { onSave(nil) } label: { Text("noteEditor.link.remove", bundle: .module) }
            }
            Button(role: .cancel) {} label: { Text("noteEditor.cancel", bundle: .module) }
        }
    }
}
