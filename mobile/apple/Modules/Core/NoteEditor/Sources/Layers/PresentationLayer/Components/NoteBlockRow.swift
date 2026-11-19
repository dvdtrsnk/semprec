import CoreKit
import DesignSystem
import SwiftUI

/// What a block's context menu asks of the editor beyond a change of blocks.
enum NoteBlockRequest: Equatable {

    case style
    case rename
    case select
}

/// One block: its marker, its text (edited in place, or shown with a tap that starts editing under the finger) or its
/// subpage link, indented by its level. A long press shows what can be done with it.
struct NoteBlockRow: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let isEditing: Bool
    let isOnlyBlock: Bool
    let caretTarget: NoteCaretTarget?
    let pendingMark: NoteEditorMark?
    let onBeginEditing: (Int) -> Void
    let onTyping: (NoteEditorTyping) -> Void
    let onKey: (NoteEditorKey) -> Void
    let onSelection: (NoteSelection) -> Void
    let onBlur: () -> Void
    let onEdit: (NoteEditorBlockEdit) -> Void
    let onRequest: (NoteBlockRequest) -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: 2) {
            if hasMarker {
                NoteBlockMarker(block: block) { onEdit(.toggleDone(blockId: block.id)) }
            }
            if block.type == .quote {
                NoteQuoteBar().padding(.vertical, NoteEditorMetrics.editorInset.height)
            }
            content
        }
        .padding(.leading, CGFloat(block.indent) * NoteBlockStyle.indentWidth)
        .padding(.top, NoteBlockStyle.spacing(above: block.type))
        .contentShape(Rectangle())
        .contextMenu { if !isEditing { menu } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.block(block.id))
    }
}

// MARK: - Subviews
private extension NoteBlockRow {

    var hasMarker: Bool {
        block.marker != nil || block.type == .todo || block.type == .page
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

    @ViewBuilder var menu: some View {
        if block.type == .page {
            item("noteEditor.menu.open", "arrow.up.right") { onEdit(.openPage(blockId: block.id)) }
            item("noteEditor.menu.rename", "pencil") { onRequest(.rename) }
        } else {
            item("noteEditor.menu.edit", "character.cursor.ibeam") { onBeginEditing(block.text.utf16.count) }
        }
        item("noteEditor.swipe.select", "checkmark.circle") { onRequest(.select) }
        item("noteEditor.menu.style", "textformat") { onRequest(.style) }
        item("noteEditor.menu.duplicate", "plus.square.on.square") { onEdit(.duplicate(blockIds: [block.id])) }
        item(
            block.type == .page ? "noteEditor.menu.deletePage" : "noteEditor.menu.delete",
            "trash",
            role: .destructive
        ) {
            onEdit(.delete(blockIds: [block.id]))
        }
    }

    func item(
        _ title: LocalizedStringKey,
        _ systemImage: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            Label { Text(title, bundle: .module) } icon: { Image(systemName: systemImage) }
        }
    }
}
