import CoreKit
import DesignSystem
import SwiftUI

/// What stands in front of a block's text: a bullet that changes with its level (filled circle, circle, square), a
/// number like "1.1.", a checkbox that a tap checks, or a page's document icon. A quote has its bar instead
/// (`NoteQuoteBar`).
struct NoteBlockMarker: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let onToggleDone: () -> Void

    // MARK: - Body
    var body: some View {
        content
            .font(NoteBlockStyle.font(block.type))
            .frame(minWidth: NoteEditorMetrics.markerWidth, alignment: .trailing)
            .padding(.vertical, NoteEditorMetrics.editorInset.height)
    }
}

// MARK: - Subviews
private extension NoteBlockMarker {

    @ViewBuilder var content: some View {
        switch block.type {
        case .todo:
            Button(action: onToggleDone) {
                Image(systemName: block.done ? "checkmark.square.fill" : "square")
                    .foregroundStyle(block.done ? Theme.Colors.accent : Theme.Colors.secondaryText)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(block.done ? "noteEditor.todo.done" : "noteEditor.todo.open", bundle: .module))
            .accessibilityIdentifier(NoteEditorIdentifiers.checkbox(block.id))
        case .page:
            Image(systemName: "doc.text")
                .foregroundStyle(Theme.Colors.secondaryText)
                .accessibilityHidden(true)
        default:
            marker.accessibilityHidden(true)
        }
    }

    @ViewBuilder var marker: some View {
        switch block.marker {
        case .bullet(let level):
            Text(verbatim: Self.bullets[level % Self.bullets.count])
                .font(.system(size: 9))
                .foregroundStyle(.primary)
        case .number(let label):
            Text(verbatim: label)
                .monospacedDigit()
                .foregroundStyle(.primary)
        case .none:
            Color.clear.frame(width: 0, height: 0)
        }
    }

    static let bullets = ["●", "○", "■"]
}

/// The bar on the left of a quote.
struct NoteQuoteBar: View {

    var body: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(Theme.Colors.secondaryText.opacity(0.5))
            .frame(width: 3)
            .accessibilityHidden(true)
    }
}
