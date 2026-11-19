import CoreKit
import DesignSystem
import SwiftUI

/// The styles a block can take, by group: text (headings and plain text), lists and blocks. A page is made only by
/// the subpage operation, and only where the note offers subpages; a page block keeps its type.
struct NoteStyleList: View {

    // MARK: - Dependencies
    let current: NoteEditorBlockType?
    let offersSubpages: Bool
    let onPick: (NoteEditorBlockType) -> Void

    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            List {
                group("noteEditor.style.text", [.heading1, .heading2, .heading3, .text])
                group("noteEditor.style.lists", [.bullet, .number, .todo])
                group("noteEditor.style.blocks", offersSubpages ? [.quote, .page] : [.quote])
            }
            .navigationTitle(Text("noteEditor.bar.style", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Text("noteEditor.done", bundle: .module) }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Subviews
private extension NoteStyleList {

    func group(_ title: LocalizedStringKey, _ types: [NoteEditorBlockType]) -> some View {
        Section {
            ForEach(types, id: \.self) { type in
                Button {
                    onPick(type)
                    dismiss()
                } label: {
                    HStack {
                        Text(NoteBlockStyle.typeName(type), bundle: .module)
                            .font(type == .text ? .body : NoteBlockStyle.font(type))
                        Spacer()
                        if type == current {
                            Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent)
                        }
                    }
                }
                .listRowButton()
                .disabled(current == .page)
            }
        } header: {
            Text(title, bundle: .module)
        }
    }
}
