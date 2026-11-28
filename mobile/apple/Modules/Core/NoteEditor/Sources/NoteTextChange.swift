import Foundation

/// What one change of an edited block's text was, read from the plain text before and after it. A software keyboard
/// types Return as a line break, and pasted lines become blocks; each of those becomes the editing action the shared
/// layer applies, so the document rules decide what they do.
enum NoteTextChange: Equatable {

    /// Ordinary typing: the new text stands as it is.
    case typed
    /// Return at `offset`: the block splits there.
    case enter(offset: Int)
    /// Lines of `text` put in at `offset` after `removed` UTF-16 units there were taken out.
    case inserted(offset: Int, removed: Int, text: String)
    /// A web address put over the selected `start..<end`: the selection gets the link.
    case linked(start: Int, end: Int, address: String)

    /// `softBreak` when the line break the new text has was put in by the editor itself (Shift-Return).
    static func between(_ old: String, _ new: String, softBreak: Bool) -> NoteTextChange {
        let before = Array(old.utf16)
        let after = Array(new.utf16)
        var prefix = 0
        while prefix < min(before.count, after.count), before[prefix] == after[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < min(before.count, after.count) - prefix,
              before[before.count - 1 - suffix] == after[after.count - 1 - suffix] {
            suffix += 1
        }
        let removed = before.count - prefix - suffix
        let inserted = String(decoding: after[prefix..<(after.count - suffix)], as: UTF16.self)
        if inserted == "\n", removed == 0 { return softBreak ? .typed : .enter(offset: prefix) }
        if removed > 0, isAddress(inserted) { return .linked(start: prefix, end: prefix + removed, address: inserted) }
        // Fast typing arrives several characters at once, so only lines put in at once are read as a paste.
        if inserted.contains("\n") { return .inserted(offset: prefix, removed: removed, text: inserted) }
        return .typed
    }

    /// Whether `text` is one web address and nothing else.
    static func isAddress(_ text: String) -> Bool {
        guard !text.contains(where: \.isWhitespace), let url = URL(string: text), let scheme = url.scheme else {
            return false
        }
        return ["http", "https"].contains(scheme.lowercased()) && url.host() != nil
    }
}
