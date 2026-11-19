import CoreKit
import DesignSystem
import SwiftUI

/// The bar of selection mode: select all or none, how many blocks are selected, and what can be done with them.
struct NoteSelectionBar: View {

    // MARK: - Dependencies
    let count: Int
    let allSelected: Bool
    let onSelectAll: () -> Void
    let onStyle: () -> Void
    let onEdit: (NoteBulkEdit) -> Void
    let onDone: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: 4) {
            HStack {
                Button(action: onSelectAll) {
                    Text(allSelected ? "noteEditor.selection.none" : "noteEditor.selection.all", bundle: .module)
                }
                Spacer()
                Text(String(format: String(localized: "noteEditor.selection.count", bundle: .module), count))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button(action: onDone) { Text("noteEditor.done", bundle: .module).bold() }
            }
            HStack {
                tool("noteEditor.bar.style", "paragraphsign", action: onStyle)
                tool("noteEditor.bar.outdent", "decrease.indent") { onEdit(.outdent) }
                tool("noteEditor.bar.indent", "increase.indent") { onEdit(.indent) }
                tool("noteEditor.menu.duplicate", "plus.square.on.square") { onEdit(.duplicate) }
                tool("noteEditor.menu.delete", "trash", role: .destructive) { onEdit(.delete) }
            }
            .disabled(count < 1)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, Theme.Spacing.small)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.selectionBar)
    }
}

/// What the selection bar does to the selected blocks.
enum NoteBulkEdit: Equatable {

    case outdent
    case indent
    case duplicate
    case delete

    func edit(_ ids: [String]) -> NoteEditorBlockEdit {
        switch self {
        case .outdent: .shiftIndent(blockIds: ids, delta: -1)
        case .indent: .shiftIndent(blockIds: ids, delta: 1)
        case .duplicate: .duplicate(blockIds: ids)
        case .delete: .delete(blockIds: ids)
        }
    }
}

// MARK: - Subviews
private extension NoteSelectionBar {

    func tool(
        _ title: LocalizedStringKey,
        _ systemImage: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage).font(.body.weight(.medium))
                Text(title, bundle: .module).font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(role == .destructive ? Theme.Colors.destructive : .primary)
    }
}

/// The blocks being moved, under the finger: the first one's text and, for several, how many there are.
struct NoteDragPreview: View {

    let block: NoteEditorBlock
    let count: Int

    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: "line.3.horizontal").foregroundStyle(Theme.Colors.secondaryText)
            Text(verbatim: block.text.isEmpty ? " " : block.text).lineLimit(1)
            if count > 1 {
                Text(verbatim: "\(count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Theme.Colors.accent, in: .capsule)
            }
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .frame(height: 44)
        .frame(maxWidth: 300, alignment: .leading)
        .background(.regularMaterial, in: .rect(cornerRadius: 12))
        .shadow(color: .black.opacity(0.2), radius: 12, y: 4)
        .allowsHitTesting(false)
    }
}
