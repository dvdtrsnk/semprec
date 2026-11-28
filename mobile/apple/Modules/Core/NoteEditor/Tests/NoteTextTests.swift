import CoreKit
import SwiftUI
import XCTest

@testable import NoteEditor

final class NoteTextTests: XCTestCase {

    func testTypingFastIsTypingAndOnlyLinesPutInAtOnceArePasted() {
        XCTAssertEqual(NoteTextChange.between("Plan", "Planning", softBreak: false), .typed)
        XCTAssertEqual(NoteTextChange.between("Plan", "Pl\nan", softBreak: false), .enter(offset: 2))
        XCTAssertEqual(NoteTextChange.between("Plan", "Pl\nan", softBreak: true), .typed)
        XCTAssertEqual(
            NoteTextChange.between("Plan", "Pla\none\ntwon", softBreak: false),
            .inserted(offset: 3, removed: 0, text: "\none\ntwo")
        )
    }

    func testAnAddressPutOverASelectionLinksIt() {
        XCTAssertEqual(
            NoteTextChange.between("See docs here", "See https://alldots.cz here", softBreak: false),
            .linked(start: 4, end: 8, address: "https://alldots.cz")
        )
        XCTAssertEqual(NoteTextChange.between("See docs", "See alldots", softBreak: false), .typed)
    }

    func testRunsKeepTheirFormatsAndLinksAndNothingElse() {
        let runs = [
            NoteEditorRun("Hello "),
            NoteEditorRun("bold", bold: true),
            NoteEditorRun(" code", italic: true, code: true),
            NoteEditorRun(" link", link: "https://alldots.cz")
        ]
        var text = NoteText.attributed(runs)
        text.foregroundColor = .cyan
        XCTAssertEqual(NoteText.runs(text), runs)
    }

    func testRunsKeepTheirStrikeUnderlineColorAndHighlight() {
        let runs = [
            NoteEditorRun("struck", strike: true),
            NoteEditorRun(" under", underline: true),
            NoteEditorRun(" red", color: .red),
            NoteEditorRun(" marked", highlight: .yellow),
            NoteEditorRun(" all", bold: true, strike: true, underline: true, color: .blue, highlight: .green)
        ]
        XCTAssertEqual(NoteText.runs(NoteText.attributed(runs)), runs)
    }

    func testAnEditedBlockReportsBackspaceAtTheStartWhenItsSentinelIsGone() {
        let runs = [NoteEditorRun("Hi")]
        let editable = NoteText.editable(runs)
        XCTAssertEqual(NoteText.editedRuns(editable), runs)
        XCTAssertNil(NoteText.editedRuns(AttributedString("Hi")))
    }

    func testOffsetsCountUTF16UnitsOfTheText() {
        let text = AttributedString("a😀b")
        XCTAssertEqual(NoteText.offset(of: NoteText.index(at: 3, in: text), in: text), 3)
        XCTAssertEqual(NoteText.offset(of: NoteText.index(at: 99, in: text), in: text), 4)
    }
}
