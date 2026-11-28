import CoreKit
import DesignSystem
import SwiftUI

/// The styles a block can take, by group: text (headings and plain text), lists, toggle headings and blocks. A page is
/// made only by the subpage operation, and only where the note offers subpages; a page block keeps its type.
struct NoteStyleList: View {

    /// A block type, and for a heading whether it folds what is under it.
    struct Style: Hashable {
        let type: NoteEditorBlockType
        var toggle = false
    }

    // MARK: - Dependencies
    let current: Style?
    let offersSubpages: Bool
    let onPick: (NoteEditorBlockType, Bool) -> Void

    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            List {
                group("noteEditor.style.text", [.heading1, .heading2, .heading3, .text].map { Style(type: $0) })
                group("noteEditor.style.lists", [.bullet, .number, .todo, .toggle].map { Style(type: $0) })
                group(
                    "noteEditor.style.toggles",
                    [.heading1, .heading2, .heading3].map { Style(type: $0, toggle: true) }
                )
                group("noteEditor.style.blocks", (offersSubpages ? [.quote, .page] : [.quote]).map { Style(type: $0) })
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

    func group(_ title: LocalizedStringKey, _ styles: [Style]) -> some View {
        Section {
            ForEach(styles, id: \.self) { style in
                Button {
                    onPick(style.type, style.toggle)
                    dismiss()
                } label: {
                    HStack(spacing: 6) {
                        if style.toggle || style.type == .toggle {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                        Text(name(style), bundle: .module)
                            .font(style.type == .text ? .body : NoteBlockStyle.font(style.type))
                        Spacer()
                        if style == current {
                            Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent)
                        }
                    }
                }
                .listRowButton()
                .disabled(current?.type == .page)
            }
        } header: {
            Text(title, bundle: .module)
        }
    }

    func name(_ style: Style) -> LocalizedStringKey {
        style.toggle ? NoteBlockStyle.toggleHeadingName(style.type) : NoteBlockStyle.typeName(style.type)
    }
}
