import CoreKit
import Foundation

// MARK: - Styled text
extension Array where Element == JournalRun {

    /// The runs as styled text: bold, italic, code and links are formatting, never syntax. Only web and mail links
    /// are links; other destinations stay plain text.
    var styled: AttributedString {
        var result = AttributedString()
        for run in self {
            var piece = AttributedString(run.text)
            var intent: InlinePresentationIntent = []
            if run.bold { intent.insert(.stronglyEmphasized) }
            if run.italic { intent.insert(.emphasized) }
            if run.code { intent.insert(.code) }
            if !intent.isEmpty { piece.inlinePresentationIntent = intent }
            if let href = run.link, let url = URL(string: href), Self.openableSchemes.contains(url.scheme ?? "") {
                piece.link = url
            }
            result.append(piece)
        }
        return result
    }

    private static var openableSchemes: Set<String> { ["http", "https", "mailto"] }
}
