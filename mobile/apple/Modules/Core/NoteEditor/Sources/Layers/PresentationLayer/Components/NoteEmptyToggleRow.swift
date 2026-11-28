import CoreKit
import SwiftUI

/// The row under an open toggle with nothing in it, which says so; a tap puts the cursor in its first child.
struct NoteEmptyToggleRow: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let onTap: () -> Void

    // MARK: - Body
    var body: some View {
        Button(action: onTap) {
            Text("noteEditor.toggle.empty", bundle: .module)
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, NoteEditorMetrics.editorInset.height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, CGFloat(block.indent + 1) * NoteBlockStyle.indentWidth + NoteEditorMetrics.editorInset.width)
        .accessibilityIdentifier(NoteEditorIdentifiers.emptyToggle(block.id))
    }
}
