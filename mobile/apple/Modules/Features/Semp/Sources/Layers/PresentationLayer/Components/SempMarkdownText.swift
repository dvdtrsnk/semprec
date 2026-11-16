import SwiftUI

/// The Markdown of a reply, shown without its syntax: paragraphs, bullet and numbered lines, and bold, italic and code
/// inside a line. Headings are shown as bold lines.
struct SempMarkdownText: View {

    // MARK: - Dependencies
    let text: String

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(SempMarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                row(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Subviews
private extension SempMarkdownText {

    @ViewBuilder
    func row(_ block: SempMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let line):
            Text(inline(line))
        case .heading(let line):
            Text(inline(line)).fontWeight(.semibold)
        case .bullet(let line):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: "\u{2022}")
                Text(inline(line))
            }
            .padding(.leading, 4)
        case .numbered(let number, let line):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: "\(number).")
                Text(inline(line))
            }
            .padding(.leading, 4)
        }
    }

    func inline(_ line: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: line, options: options)) ?? AttributedString(line)
    }
}

// MARK: - Blocks
/// One line group of a Markdown text.
enum SempMarkdownBlock: Equatable {

    case paragraph(String)
    case heading(String)
    case bullet(String)
    case numbered(Int, String)

    /// Splits a Markdown text into its lines: blank lines only separate, a line that starts a list or a heading
    /// stands alone, and any other line is a paragraph.
    static func parse(_ text: String) -> [SempMarkdownBlock] {
        text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { return nil }
            if let match = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) { return .heading(String(match.output.2)) }
            if let match = line.firstMatch(of: /^[-*\u{2022}]\s+(.*)$/) { return .bullet(String(match.output.1)) }
            if let match = line.firstMatch(of: /^(\d{1,3})[.)]\s+(.*)$/), let number = Int(match.output.1) {
                return .numbered(number, String(match.output.2))
            }
            return .paragraph(line)
        }
    }
}

#Preview {
    SempMarkdownText(text: "Dnes tě čeká:\n- **14:00** úkol Odeslat fakturu\n- 15:00 Fokus\n1. první\n2. druhý")
        .padding()
}
