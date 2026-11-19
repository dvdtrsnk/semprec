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

/// The blocks being moved, lifted under the finger: the first one as it looks in the note and, for several, how many
/// there are.
struct NoteDragPreview: View {

    let block: NoteEditorBlock
    let count: Int
    /// The width of the space the blocks are shown in.
    let width: CGFloat

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            Text(NoteText.attributed(block.runs))
                .font(NoteBlockStyle.font(block.type))
                .foregroundStyle(NoteBlockStyle.color(block))
                .frame(maxWidth: .infinity, alignment: .leading)
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
        .padding(.vertical, Theme.Spacing.small)
        .frame(width: max(width - 2 * Theme.Spacing.small, 0), alignment: .leading)
        .background(Theme.Colors.card, in: .rect(cornerRadius: 8))
        .shadow(color: .black.opacity(0.22), radius: 16, y: 6)
        .offset(x: Theme.Spacing.small)
        .allowsHitTesting(false)
    }
}

/// The line showing where blocks being moved go when the finger lifts.
struct NoteDropLine: View {

    /// Where in the blocks' space the line is.
    let top: CGFloat
    let inset: CGFloat

    var body: some View {
        Capsule()
            .fill(Theme.Colors.accent)
            .frame(height: 3)
            .padding(.horizontal, inset)
            .offset(y: top - 1.5)
            .animation(.snappy(duration: 0.2), value: top)
            .allowsHitTesting(false)
    }
}
