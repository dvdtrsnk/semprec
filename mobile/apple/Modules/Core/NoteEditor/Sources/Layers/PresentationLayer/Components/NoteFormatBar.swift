import CoreKit
import DesignSystem
import SwiftUI

/// The bar right above the keyboard while part of a block's text is selected, across the whole width: bold, italic,
/// code, a link and taking the formats off, and at the right the key that puts the keyboard away. What the selection
/// already has is highlighted.
struct NoteFormatBar: View {

    // MARK: - Dependencies
    let selection: NoteSelection
    let onTyping: @MainActor (NoteEditorTyping) -> Void
    let onLink: @MainActor () -> Void
    let onDone: @MainActor () -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 0) {
                mark(.bold, "noteEditor.format.bold", systemImage: "bold")
                mark(.italic, "noteEditor.format.italic", systemImage: "italic")
                mark(.code, "noteEditor.format.code", systemImage: "chevron.left.forwardslash.chevron.right")
                tool("noteEditor.format.link", systemImage: "link", isActive: selection.link != nil, action: onLink)
                tool("noteEditor.format.clear", systemImage: "eraser") {
                    onTyping(.clearFormat(blockId: selection.blockId, start: selection.start, end: selection.end))
                }
                Divider().frame(height: 24)
                tool("noteEditor.done", systemImage: "keyboard.chevron.compact.down", action: onDone)
            }
            .frame(height: 44)
        }
        .background(Theme.Colors.card)
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
        action: @escaping @MainActor () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(isActive ? Theme.Colors.accent : .primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title, bundle: .module))
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
