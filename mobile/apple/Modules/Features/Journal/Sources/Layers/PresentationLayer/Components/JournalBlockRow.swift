import CoreKit
import DesignSystem
import SwiftUI

/// One block of a page as formatted text, with the marker its type has (bullet, number, check, quote bar) and a link
/// row for a subpage. Tapping the text asks to edit it; tapping the check or a subpage link asks for that.
struct JournalBlockRow: View {

    // MARK: - Dependencies
    let block: JournalBlock
    let identifier: String
    let onEdit: () -> Void
    let onToggle: () -> Void
    let onOpenPage: (String, String) -> Void

    // MARK: - Body
    var body: some View {
        Group {
            if block.kind == .page {
                pageLink
            } else {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
                    marker
                    text
                }
                .padding(.leading, CGFloat(block.indent) * Theme.Spacing.medium)
            }
        }
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Subviews
private extension JournalBlockRow {

    @ViewBuilder var marker: some View {
        switch block.kind {
        case .bullet:
            Text(verbatim: "\u{2022}").foregroundStyle(Theme.Colors.secondaryText)
        case .number:
            Text(verbatim: "\(block.ordinal).").foregroundStyle(Theme.Colors.secondaryText).monospacedDigit()
        case .todo:
            Button(action: onToggle) {
                Image(systemName: block.done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(block.done ? Theme.Colors.accent : Theme.Colors.secondaryText)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(block.done ? "journal.todo.done" : "journal.todo.open", bundle: .module))
        case .quote:
            RoundedRectangle(cornerRadius: 1.5).fill(Theme.Colors.secondaryText).frame(width: 3)
        case .text, .heading1, .heading2, .heading3, .page:
            EmptyView()
        }
    }

    var text: some View {
        Text(block.runs.styled)
            .font(font)
            .strikethrough(block.kind == .todo && block.done)
            .foregroundStyle(muted ? Theme.Colors.secondaryText : .primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
            .onTapGesture(perform: onEdit)
    }

    /// Finished to-dos and quotes are set back from the rest of the text.
    var muted: Bool {
        (block.kind == .todo && block.done) || block.kind == .quote
    }

    var font: Font {
        switch block.kind {
        case .heading1: .title2.weight(.bold)
        case .heading2: .title3.weight(.semibold)
        case .heading3: .headline
        default: Theme.Typography.body
        }
    }

    var caption: String {
        block.plainText.isEmpty ? String(localized: "journal.subpage.untitled", bundle: .module) : block.plainText
    }

    var pageLink: some View {
        Button {
            if let pageId = block.pageId { onOpenPage(pageId, block.plainText) }
        } label: {
            HStack(spacing: Theme.Spacing.small) {
                Image(systemName: "doc.text").foregroundStyle(Theme.Colors.accent)
                Text(caption).foregroundStyle(.primary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Preview
#Preview("Blocks") {
    VStack(alignment: .leading, spacing: 8) {
        JournalBlockRow(
            block: JournalBlock(index: 0, kind: .heading2, runs: [JournalRun(text: "Oblečení")]),
            identifier: "a", onEdit: {}, onToggle: {}, onOpenPage: { _, _ in }
        )
        JournalBlockRow(
            block: JournalBlock(
                index: 1, kind: .todo, done: true,
                runs: [JournalRun(text: "Nepromokavá "), JournalRun(text: "bunda", bold: true)]
            ),
            identifier: "b", onEdit: {}, onToggle: {}, onOpenPage: { _, _ in }
        )
        JournalBlockRow(
            block: JournalBlock(index: 2, kind: .number, ordinal: 2, runs: [JournalRun(text: "Druhá", italic: true)]),
            identifier: "c", onEdit: {}, onToggle: {}, onOpenPage: { _, _ in }
        )
        JournalBlockRow(
            block: JournalBlock(index: 3, kind: .page, runs: [JournalRun(text: "Krkonoše – co sbalit")], pageId: "p"),
            identifier: "d", onEdit: {}, onToggle: {}, onOpenPage: { _, _ in }
        )
    }
    .padding()
}
