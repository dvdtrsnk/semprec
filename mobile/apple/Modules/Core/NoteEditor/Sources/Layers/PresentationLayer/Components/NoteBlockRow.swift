import CoreKit
import DesignSystem
import SwiftUI

/// One block: its marker or toggle arrow, its text (edited in place, or shown with a tap that starts editing under the
/// finger) or its subpage link, indented by its level.
struct NoteBlockRow: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let isEditing: Bool
    let isOnlyBlock: Bool
    let isFolded: Bool
    let caretTarget: NoteCaretTarget?
    let pendingMark: NoteEditorMark?
    let onBeginEditing: (Int) -> Void
    let onTyping: (NoteEditorTyping) -> Void
    let onKey: (NoteEditorKey) -> Void
    let onSelection: (NoteSelection) -> Void
    let onBlur: () -> Void
    let onEdit: (NoteEditorBlockEdit) -> Void
    let onFold: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: 2) {
            if hasMarker {
                NoteBlockMarker(
                    block: block,
                    isFolded: isFolded,
                    onToggleDone: { onEdit(.toggleDone(blockId: block.id)) },
                    onFold: onFold
                )
            }
            if block.type == .quote {
                NoteQuoteBar().padding(.vertical, NoteEditorMetrics.editorInset.height)
            }
            content
        }
        .padding(.leading, CGFloat(block.indent) * NoteBlockStyle.indentWidth)
        .padding(.top, NoteBlockStyle.spacing(above: block.type))
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.block(block.id))
    }
}

// MARK: - Subviews
private extension NoteBlockRow {

    var hasMarker: Bool {
        block.marker != nil || block.type == .todo || block.type == .page || NoteFolding.folds(block)
    }

    var placeholder: LocalizedStringKey? {
        NoteBlockStyle.placeholder(block.type, isOnlyBlock: isOnlyBlock, isEditing: isEditing)
    }

    @ViewBuilder var content: some View {
        if block.type == .page {
            Button { onEdit(.openPage(blockId: block.id)) } label: { pageLink }
                .buttonStyle(.plain)
                .accessibilityIdentifier(NoteEditorIdentifiers.pageLink(block.id))
        } else if isEditing {
            NoteBlockEditor(
                block: block,
                placeholder: placeholder,
                caretTarget: caretTarget,
                pendingMark: pendingMark,
                onTyping: onTyping,
                onKey: onKey,
                onSelection: onSelection,
                onBlur: onBlur
            )
        } else {
            NoteBlockText(block: block, placeholder: placeholder, onTap: onBeginEditing)
        }
    }

    var pageLink: some View {
        HStack(spacing: Theme.Spacing.small) {
            Group {
                if block.text.isEmpty {
                    Text("noteEditor.page.untitled", bundle: .module).foregroundStyle(.secondary)
                } else {
                    Text(verbatim: block.text)
                }
            }
            .underline()
            .font(NoteBlockStyle.font(.page))
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, NoteEditorMetrics.editorInset.width)
        .padding(.vertical, NoteEditorMetrics.editorInset.height)
        .contentShape(Rectangle())
    }
}
