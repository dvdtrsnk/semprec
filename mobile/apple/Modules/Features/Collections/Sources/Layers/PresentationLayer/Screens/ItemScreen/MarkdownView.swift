import DesignSystem
import SwiftUI

/// The Markdown of a page drawn without its syntax: headings, bullets, numbered and checked items, quotes and
/// paragraphs, with bold, italic, code and links inside the text.
struct MarkdownView: View {

    // MARK: - Dependencies
    let markdown: String

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(MarkdownBlock.parse(markdown)) { block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Subviews
private extension MarkdownView {

    @ViewBuilder
    func view(for block: MarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level):
            inline(block.text).font(level == 1 ? .title3.bold() : .headline)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•"); inline(block.text) }
        case .number(let number):
            HStack(alignment: .firstTextBaseline, spacing: 8) { Text("\(number)."); inline(block.text) }
        case .todo(let done):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle").foregroundStyle(Theme.Colors.accent)
                inline(block.text).strikethrough(done)
            }
        case .quote:
            inline(block.text)
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Theme.Colors.secondaryText.opacity(0.4)).frame(width: 3)
                }
        case .paragraph:
            inline(block.text)
        }
    }

    func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return Text(attributed)
        }
        return Text(text)
    }
}

/// One block of a page: a line of its Markdown with the kind its prefix gives it.
struct MarkdownBlock: Identifiable, Equatable {

    // MARK: - Kind
    enum Kind: Equatable {

        case heading(level: Int)
        case bullet
        case number(Int)
        case todo(done: Bool)
        case quote
        case paragraph
    }

    // MARK: - Properties
    let id: Int
    let kind: Kind
    let text: String

    // MARK: - Parsing
    /// The blocks of `markdown`, one per non-empty line.
    static func parse(_ markdown: String) -> [MarkdownBlock] {
        markdown.split(separator: "\n", omittingEmptySubsequences: true)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .enumerated()
            .map { index, line in
                let (kind, text) = classify(line)
                return MarkdownBlock(id: index, kind: kind, text: text)
            }
    }

    private static func classify(_ line: String) -> (Kind, String) {
        if let heading = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) {
            return (.heading(level: heading.1.count), String(heading.2))
        }
        if let todo = line.firstMatch(of: /^[-*]\s+\[([ xX])\]\s+(.*)$/) {
            return (.todo(done: todo.1 != " "), String(todo.2))
        }
        if let bullet = line.firstMatch(of: /^[-*+]\s+(.*)$/) {
            return (.bullet, String(bullet.1))
        }
        if let number = line.firstMatch(of: /^(\d+)[.)]\s+(.*)$/) {
            return (.number(Int(number.1) ?? 1), String(number.2))
        }
        if let quote = line.firstMatch(of: /^>\s?(.*)$/) {
            return (.quote, String(quote.1))
        }
        return (.paragraph, line)
    }
}
