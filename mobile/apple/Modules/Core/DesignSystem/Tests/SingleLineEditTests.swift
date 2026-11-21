import XCTest

@testable import DesignSystem

/// What an edit of a title field leaves in it: a Return press ends the editing without a line break, pasted lines
/// are joined by spaces, and any other edit is kept as typed.
final class SingleLineEditTests: XCTestCase {

    // MARK: - Types
    private struct Case {
        let old: String
        let new: String
        let text: String
        let isReturn: Bool
    }

    // MARK: - Tests
    func testAnEditKeepsTheTitleOnOneLine() {
        let cases = [
            Case(old: "Lunch", new: "Lunch with", text: "Lunch with", isReturn: false),
            Case(old: "Lunch", new: "Lunch\n", text: "Lunch", isReturn: true),
            Case(old: "Lunch", new: "Lu\nnch", text: "Lunch", isReturn: true),
            Case(old: "", new: "\n", text: "", isReturn: true),
            Case(old: "Lunch", new: "Lunch\r\n", text: "Lunch", isReturn: true),
            Case(old: "Lunch", new: "Lunch with\nEva", text: "Lunch with Eva", isReturn: false),
            Case(old: "", new: "Lunch \n\n  with Eva\n", text: "Lunch with Eva", isReturn: false),
            Case(old: "", new: "\nLunch", text: "Lunch", isReturn: false),
            Case(old: "Lunch", new: "Lunch\u{2028}Eva", text: "Lunch Eva", isReturn: false)
        ]
        for edit in cases {
            let result = SingleLineEdit(from: edit.old, to: edit.new)
            XCTAssertEqual(result.text, edit.text, "for \(edit.new.debugDescription)")
            XCTAssertEqual(result.isReturn, edit.isReturn, "for \(edit.new.debugDescription)")
        }
    }
}
