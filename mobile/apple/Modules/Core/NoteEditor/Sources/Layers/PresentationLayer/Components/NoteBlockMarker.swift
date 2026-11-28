import CoreKit
import DesignSystem
import SwiftUI

/// What stands in front of a block's text: a bullet that changes with its level (filled circle, circle, square), a
/// number like "1.1.", a checkbox that a tap checks, a toggle's arrow that a tap opens or closes, or a page's document
/// icon. A quote has its bar instead
/// (`NoteQuoteBar`).
struct NoteBlockMarker: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let isFolded: Bool
    let onToggleDone: () -> Void
    let onFold: () -> Void

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
        if NoteFolding.folds(block) {
            arrow
        } else {
            typeMarker
        }
    }

    /// The arrow sits in the middle of the block's first line, whatever its size.
    var arrow: some View {
        Text(verbatim: "M")
            .hidden()
            .overlay {
                Button(action: onFold) {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .rotationEffect(.degrees(isFolded ? 0 : 90))
                        .animation(.snappy(duration: 0.2), value: isFolded)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    Text(isFolded ? "noteEditor.toggle.open" : "noteEditor.toggle.close", bundle: .module)
                )
                .accessibilityIdentifier(NoteEditorIdentifiers.fold(block.id))
            }
    }

    @ViewBuilder var typeMarker: some View {
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
