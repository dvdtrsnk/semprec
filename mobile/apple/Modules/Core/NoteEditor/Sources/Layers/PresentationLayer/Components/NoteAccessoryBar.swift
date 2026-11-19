import CoreKit
import DesignSystem
import SwiftUI

/// The bar above the keyboard while a block is edited: text formats, the block's style, to-do and bullet (each
/// switching the type and back to text), outdent and indent and, in a full page, a subpage. "Text format" swaps it for
/// bold, italic, code and link. What applies to the cursor is highlighted.
struct NoteAccessoryBar: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let selection: NoteSelection?
    let offersSubpages: Bool
    let onTyping: (NoteEditorTyping) -> Void
    let onEdit: (NoteEditorBlockEdit) -> Void
    let onStyle: () -> Void
    let onLink: () -> Void
    let onDone: () -> Void

    // MARK: - State
    @State private var formatting = false

    // MARK: - Body
    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 2) {
                    if formatting { formats } else { tools }
                }
                .padding(.horizontal, Theme.Spacing.small)
            }
            .scrollIndicators(.hidden)
            Button(action: onDone) { Text("noteEditor.done", bundle: .module).bold() }
                .padding(.horizontal, Theme.Spacing.medium)
                .accessibilityIdentifier(NoteEditorIdentifiers.done)
        }
        .frame(height: 44)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.accessoryBar)
    }
}

// MARK: - Subviews
private extension NoteAccessoryBar {

    @ViewBuilder var tools: some View {
        tool("noteEditor.bar.format", systemImage: "textformat") { formatting = true }
        tool("noteEditor.bar.style", systemImage: "paragraphsign", action: onStyle)
        tool("noteEditor.bar.todo", systemImage: "checkmark.square", isActive: block.type == .todo) {
            onEdit(.toggleType(blockIds: [block.id], type: .todo))
        }
        tool("noteEditor.bar.bullet", systemImage: "list.bullet", isActive: block.type == .bullet) {
            onEdit(.toggleType(blockIds: [block.id], type: .bullet))
        }
        tool("noteEditor.bar.outdent", systemImage: "decrease.indent", isEnabled: block.indent > 0) {
            onEdit(.shiftIndent(blockIds: [block.id], delta: -1))
        }
        tool("noteEditor.bar.indent", systemImage: "increase.indent", isEnabled: block.indent < 5) {
            onEdit(.shiftIndent(blockIds: [block.id], delta: 1))
        }
        if offersSubpages {
            tool("noteEditor.bar.subpage", systemImage: "doc.badge.plus") {
                onEdit(.makeSubpage(blockId: block.id))
            }
        }
    }

    @ViewBuilder var formats: some View {
        tool("noteEditor.bar.back", systemImage: "chevron.left") { formatting = false }
        mark(.bold, "noteEditor.bar.bold", systemImage: "bold")
        mark(.italic, "noteEditor.bar.italic", systemImage: "italic")
        mark(.code, "noteEditor.bar.code", systemImage: "chevron.left.forwardslash.chevron.right")
        tool("noteEditor.bar.link", systemImage: "link", isActive: selection?.link != nil, action: onLink)
    }

    func mark(_ mark: NoteEditorMark, _ title: LocalizedStringKey, systemImage: String) -> some View {
        tool(title, systemImage: systemImage, isActive: selection?.marks.contains(mark) == true) {
            let start = selection?.start ?? 0
            onTyping(.toggleMark(blockId: block.id, start: start, end: selection?.end ?? start, mark: mark))
        }
    }

    func tool(
        _ title: LocalizedStringKey,
        systemImage: String,
        isActive: Bool = false,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(isActive ? Theme.Colors.accent : .primary)
                .frame(width: 40, height: 36)
                .background(isActive ? Theme.Colors.accent.opacity(0.15) : .clear, in: .rect(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.35)
        .accessibilityLabel(Text(title, bundle: .module))
    }
}
