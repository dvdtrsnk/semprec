import CoreKit
import DesignSystem
import SwiftUI

/// The bar above the keyboard while part of a block's text is selected: bold, italic, code, a link and taking the
/// formats off. What the selection already has is highlighted.
struct NoteFormatBar: View {

    // MARK: - Dependencies
    let selection: NoteSelection
    let onTyping: (NoteEditorTyping) -> Void
    let onLink: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            mark(.bold, "noteEditor.format.bold", systemImage: "bold")
            mark(.italic, "noteEditor.format.italic", systemImage: "italic")
            mark(.code, "noteEditor.format.code", systemImage: "chevron.left.forwardslash.chevron.right")
            tool("noteEditor.format.link", systemImage: "link", isActive: selection.link != nil, action: onLink)
            tool("noteEditor.format.clear", systemImage: "textformat.slash") {
                onTyping(.clearFormat(blockId: selection.blockId, start: selection.start, end: selection.end))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.formatBar)
    }
}

// MARK: - Subviews
private extension NoteFormatBar {

    func mark(_ mark: NoteEditorMark, _ title: LocalizedStringKey, systemImage: String) -> some View {
        tool(title, systemImage: systemImage, isActive: selection.marks.contains(mark)) {
            onTyping(.toggleMark(blockId: selection.blockId, start: selection.start, end: selection.end, mark: mark))
        }
    }

    func tool(
        _ title: LocalizedStringKey,
        systemImage: String,
        isActive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(isActive ? Theme.Colors.accent : .primary)
                .frame(width: 40, height: 34)
                .background(isActive ? Theme.Colors.accent.opacity(0.18) : .clear, in: .rect(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title, bundle: .module))
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
