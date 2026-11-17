import Foundation

/// The inline Markdown of a note block (bold, italic, code, links) as styled text. A soft line break is stored as
/// `<br>`; it becomes a line break of the text.
enum NoteInline {

    // MARK: - Methods
    /// The styled text of `markdown`; a text that is not valid Markdown is shown as it is.
    static func attributed(_ markdown: String) -> AttributedString {
        let text = markdown.replacingOccurrences(of: "<br>", with: "\n")
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    /// The text of `markdown` without any styling, for a label that reads it out.
    static func plain(_ markdown: String) -> String {
        String(attributed(markdown).characters)
    }
}
