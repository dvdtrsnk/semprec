import CoreKit
import Foundation
import SwiftUI

/// A block's formatted text as the editor holds it. Bold, italic and code are inline presentation intents, a link is
/// the link attribute; nothing else of an attributed string is read back, so formatting pasted from elsewhere never
/// reaches the note. Offsets count UTF-16 units, as the shared layer does.
enum NoteText {

    /// The zero-width character in front of an edited block's text. A software keyboard reports no key for Backspace
    /// at the start of a field; deleting this character is how the editor sees it.
    static let sentinel = "\u{200B}"

    static func attributed(_ runs: [NoteEditorRun]) -> AttributedString {
        runs.reduce(into: AttributedString()) { text, run in
            var part = AttributedString(run.text)
            part.inlinePresentationIntent = intent(of: run)
            if let link = run.link, let url = URL(string: link) { part.link = url }
            text += part
        }
    }

    /// The runs of `text`, joined where neighbours have the same format.
    static func runs(_ text: AttributedString) -> [NoteEditorRun] {
        var runs: [NoteEditorRun] = []
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            let part = NoteEditorRun(
                String(text[run.range].characters).replacingOccurrences(of: sentinel, with: ""),
                bold: intent.contains(.stronglyEmphasized),
                italic: intent.contains(.emphasized),
                code: intent.contains(.code),
                link: run.link?.absoluteString
            )
            if let last = runs.last, last.sameFormat(as: part) {
                runs[runs.count - 1].text += part.text
            } else if !part.text.isEmpty {
                runs.append(part)
            }
        }
        return runs
    }

    /// The text as an edited block holds it: the sentinel, then the text.
    static func editable(_ runs: [NoteEditorRun]) -> AttributedString {
        AttributedString(sentinel) + attributed(runs)
    }

    /// The runs of an edited block's text, or `nil` when its sentinel was deleted.
    static func editedRuns(_ text: AttributedString) -> [NoteEditorRun]? {
        guard text.characters.first.map(String.init) == sentinel else { return nil }
        return runs(AttributedString(text[text.index(afterCharacter: text.startIndex)...]))
    }

    /// The UTF-16 offset of `index` in `text`.
    static func offset(of index: AttributedString.Index, in text: AttributedString) -> Int {
        String(text[text.startIndex..<index].characters).utf16.count
    }

    /// The index `offset` UTF-16 units into `text`, kept inside it.
    static func index(at offset: Int, in text: AttributedString) -> AttributedString.Index {
        var index = text.startIndex
        var counted = 0
        while index < text.endIndex {
            let next = text.index(afterCharacter: index)
            let width = String(text[index..<next].characters).utf16.count
            if counted + width > offset { break }
            counted += width
            index = next
        }
        return index
    }

    static func intent(of run: NoteEditorRun) -> InlinePresentationIntent? {
        var intent: InlinePresentationIntent = []
        if run.bold { intent.insert(.stronglyEmphasized) }
        if run.italic { intent.insert(.emphasized) }
        if run.code { intent.insert(.code) }
        return intent.isEmpty ? nil : intent
    }
}

private extension NoteEditorRun {

    func sameFormat(as other: NoteEditorRun) -> Bool {
        bold == other.bold && italic == other.italic && code == other.code && link == other.link
    }
}
