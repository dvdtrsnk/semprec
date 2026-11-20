import CoreKit
import DesignSystem
import SwiftUI

/// The panel of selection mode, in Liquid Glass where the tab bar was: how many blocks are selected, select all or
/// none, and what can be done with them in a row that scrolls sideways when it does not fit.
struct NoteSelectionPanel: View {

    // MARK: - Dependencies
    let actions: NoteSelectionActions

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.small) {
            HStack {
                Text(String(format: String(localized: "noteEditor.selection.count", bundle: .module), actions.count))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button(action: actions.selectAll) {
                    Text(selectAllTitle, bundle: .module).font(.subheadline.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.Colors.accent)
            }
            .padding(.horizontal, Theme.Spacing.medium)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    tool("noteEditor.bar.style", "paragraphsign", action: actions.style)
                    ForEach(NoteBulkEdit.allCases, id: \.self) { bulk in
                        tool(bulk.title, bulk.systemImage, role: bulk == .delete ? .destructive : nil) {
                            actions.edit(bulk)
                        }
                    }
                }
                .padding(.horizontal, Theme.Spacing.small)
            }
            .disabled(actions.count < 1)
        }
        .padding(.vertical, 12)
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.bottom, Theme.Spacing.small)
        .hidesFloatingControls()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.selectionBar)
    }
}

/// What the selection panel shows and does; the note's editor keeps it current while its blocks are selected.
struct NoteSelectionActions {

    let count: Int
    let allSelected: Bool
    let selectAll: @MainActor () -> Void
    let style: @MainActor () -> Void
    let edit: @MainActor (NoteBulkEdit) -> Void
}

/// What the selection panel does to the selected blocks.
enum NoteBulkEdit: Equatable, CaseIterable {

    case outdent
    case indent
    case bullets
    case numbers
    case todos
    case duplicate
    case delete

    func edit(_ ids: [String]) -> NoteEditorBlockEdit {
        switch self {
        case .outdent: .shiftIndent(blockIds: ids, delta: -1)
        case .indent: .shiftIndent(blockIds: ids, delta: 1)
        case .bullets: .toggleType(blockIds: ids, type: .bullet)
        case .numbers: .toggleType(blockIds: ids, type: .number)
        case .todos: .toggleType(blockIds: ids, type: .todo)
        case .duplicate: .duplicate(blockIds: ids)
        case .delete: .delete(blockIds: ids)
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .outdent: "noteEditor.bar.outdent"
        case .indent: "noteEditor.bar.indent"
        case .bullets: "noteEditor.menu.list.bullet"
        case .numbers: "noteEditor.menu.list.number"
        case .todos: "noteEditor.type.todo"
        case .duplicate: "noteEditor.menu.duplicate"
        case .delete: "noteEditor.menu.delete"
        }
    }

    var systemImage: String {
        switch self {
        case .outdent: "decrease.indent"
        case .indent: "increase.indent"
        case .bullets: "list.bullet"
        case .numbers: "list.number"
        case .todos: "checklist"
        case .duplicate: "plus.square.on.square"
        case .delete: "trash"
        }
    }
}

// MARK: - Subviews
private extension NoteSelectionPanel {

    var selectAllTitle: LocalizedStringKey {
        actions.allSelected ? "noteEditor.selection.none" : "noteEditor.selection.all"
    }

    func tool(
        _ title: LocalizedStringKey,
        _ systemImage: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .frame(height: 26)
                Text(title, bundle: .module)
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(minWidth: 72, minHeight: 52)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
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
        .background(Theme.Colors.card.opacity(0.45), in: .rect(cornerRadius: 8))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .opacity(0.85)
        .offset(x: Theme.Spacing.small)
        .allowsHitTesting(false)
    }
}

/// The line showing where blocks being moved go when the finger lifts.
struct NoteDropLine: View {

    /// Where in the blocks' space the line is.
    let top: CGFloat
    let inset: CGFloat
    /// The level the dropped blocks take, which the line starts at.
    let indent: Int
    /// A drop inside a toggle starts the line with a small ring.
    let insideToggle: Bool

    var body: some View {
        HStack(spacing: 0) {
            if insideToggle {
                Circle()
                    .strokeBorder(Theme.Colors.accent, lineWidth: 2.5)
                    .frame(width: 10, height: 10)
            }
            Capsule()
                .fill(Theme.Colors.accent)
                .frame(height: 3)
        }
        .frame(height: 10)
        .padding(.leading, inset + CGFloat(indent) * NoteBlockStyle.indentWidth)
        .padding(.trailing, inset)
        .offset(y: top - 5)
            .animation(.snappy(duration: 0.2), value: top)
            .animation(.snappy(duration: 0.2), value: indent)
            .allowsHitTesting(false)
    }
}
