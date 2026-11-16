import CoreKit
import DesignSystem
import SwiftUI

/// One block of a page, drawn by its type: text, three heading levels, bullet, number, todo, quote, or a link to a
/// subpage. The marker of a bullet or a number is drawn here and never stored; the indent shifts the block.
struct NoteBlockView: View {

    // MARK: - Dependencies
    let block: NoteBlockItem

    // MARK: - Body
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
            marker
            content
            Spacer(minLength: 0)
        }
        .padding(.leading, CGFloat(block.indent) * Self.indentWidth)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Subviews
private extension NoteBlockView {

    static let indentWidth: CGFloat = 22

    @ViewBuilder var marker: some View {
        switch block.type {
        case .bullet:
            Text(verbatim: "\u{2022}").foregroundStyle(Theme.Colors.secondaryText)
        case .number:
            Text(verbatim: block.marker ?? "").foregroundStyle(Theme.Colors.secondaryText).monospacedDigit()
        case .todo:
            Image(systemName: block.done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(block.done ? Theme.Colors.accent : Theme.Colors.secondaryText)
                .accessibilityLabel(
                    Text(block.done ? "notes.todo.done" : "notes.todo.open", bundle: .module)
                )
        case .quote:
            RoundedRectangle(cornerRadius: 1.5).fill(Theme.Colors.secondaryText.opacity(0.5)).frame(width: 3)
        case .page:
            Image(systemName: "doc.text").foregroundStyle(Theme.Colors.accent).accessibilityHidden(true)
        case .text, .heading1, .heading2, .heading3:
            EmptyView()
        }
    }

    var content: some View {
        Text(NoteInline.attributed(block.text.isEmpty && block.type == .page ? " " : block.text))
            .font(font)
            .foregroundStyle(foreground)
            .strikethrough(block.type == .todo && block.done)
            .fixedSize(horizontal: false, vertical: true)
    }

    var font: Font {
        switch block.type {
        case .heading1: .title.weight(.bold)
        case .heading2: .title2.weight(.semibold)
        case .heading3: .title3.weight(.semibold)
        case .quote: .body.italic()
        case .page: .body.weight(.medium)
        case .text, .bullet, .number, .todo: .body
        }
    }

    var foreground: Color {
        switch block.type {
        case .quote: Theme.Colors.secondaryText
        case .todo where block.done: Theme.Colors.secondaryText
        case .page: Theme.Colors.accent
        default: .primary
        }
    }
}

// MARK: - Preview
#Preview {
    VStack(alignment: .leading, spacing: 8) {
        NoteBlockView(
            block: NoteBlockItem(
                id: "1",
                type: .heading1,
                indent: 0,
                done: false,
                text: "Plan",
                pageId: nil,
                marker: nil
            )
        )
        NoteBlockView(
            block: NoteBlockItem(
                id: "2", type: .number, indent: 1, done: false, text: "A **bold** point", pageId: nil, marker: "2.1."
            )
        )
        NoteBlockView(
            block: NoteBlockItem(id: "3", type: .todo, indent: 0, done: true, text: "Done", pageId: nil, marker: nil)
        )
        NoteBlockView(
            block: NoteBlockItem(
                id: "4",
                type: .page,
                indent: 0,
                done: false,
                text: "Subpage",
                pageId: "p1",
                marker: nil
            )
        )
    }
    .padding()
}
