import SwiftUI

/// What one edit of a title field leaves in it. A title stays on one line however long it wraps: a Return press (a
/// line break added and nothing else changed) ends the editing instead of breaking the line, and the line breaks of
/// pasted text become spaces between its words.
public struct SingleLineEdit {

    // MARK: - Properties
    /// The text the field keeps.
    public let text: String
    /// Whether the edit was a Return press, which ends the editing.
    public let isReturn: Bool

    // MARK: - Init
    /// The edit that changes `old` into `new`.
    public init(from old: String, to new: String) {
        guard new.unicodeScalars.contains(where: Self.isLineBreak) else {
            text = new
            isReturn = false
            return
        }
        var unbroken = String.UnicodeScalarView()
        unbroken.append(contentsOf: new.unicodeScalars.filter { !Self.isLineBreak($0) })
        if String(unbroken) == old {
            text = old
            isReturn = true
        } else {
            text = Self.joiningLines(new)
            isReturn = false
        }
    }
}

// MARK: - Private
private extension SingleLineEdit {

    static func isLineBreak(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "\n" || scalar == "\r" || scalar == "\u{2028}" || scalar == "\u{2029}"
    }

    /// Each line break with the whitespace around it as one space; none before the first word or after the last.
    static func joiningLines(_ text: String) -> String {
        var joined = String.UnicodeScalarView()
        var breaksLine = false
        for scalar in text.unicodeScalars {
            if isLineBreak(scalar) {
                while let last = joined.last, last.properties.isWhitespace { joined.removeLast() }
                breaksLine = true
                continue
            }
            if breaksLine {
                if scalar.properties.isWhitespace { continue }
                if !joined.isEmpty { joined.append(" ") }
                breaksLine = false
            }
            joined.append(scalar)
        }
        return String(joined)
    }
}

// MARK: - View
extension View {

    /// Keeps the title in `text` on one line: Return calls `onReturn` instead of breaking the line, whether the field
    /// takes it as a line break (a vertical field on iOS) or as a submit (on a Mac), and a pasted line break becomes a
    /// space. The field may still wrap a long title over several lines.
    public func singleLineTitle(_ text: Binding<String>, onReturn: @escaping @MainActor () -> Void) -> some View {
        onChange(of: text.wrappedValue) { old, new in
            let edit = SingleLineEdit(from: old, to: new)
            if edit.text != new { text.wrappedValue = edit.text }
            if edit.isReturn { onReturn() }
        }
        .onSubmit { onReturn() }
        .submitLabel(.done)
    }
}
