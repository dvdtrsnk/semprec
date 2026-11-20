import CoreKit
import XCTest

@testable import NoteEditor

final class NoteFoldingTests: XCTestCase {

    private let blocks = [
        NoteEditorBlock(id: "t", type: .toggle),
        NoteEditorBlock(id: "t1", type: .text, indent: 1),
        NoteEditorBlock(id: "t2", type: .toggle, indent: 1),
        NoteEditorBlock(id: "t3", type: .bullet, indent: 2),
        NoteEditorBlock(id: "after", type: .text),
        NoteEditorBlock(id: "h", type: .heading2, toggle: true),
        NoteEditorBlock(id: "h1", type: .text, indent: 1),
        NoteEditorBlock(id: "h2", type: .heading3, indent: 1),
        NoteEditorBlock(id: "next", type: .text),
        NoteEditorBlock(id: "plain", type: .heading1),
        NoteEditorBlock(id: "p1", type: .text)
    ]

    private func visible(_ folded: Set<String>) -> [String] {
        NoteFolding.visible(blocks, folded: folded).map(\.id)
    }

    func testAClosedToggleHidesWhatIsIndentedUnderIt() {
        XCTAssertEqual(visible(["t"]), ["t", "after", "h", "h1", "h2", "next", "plain", "p1"])
        XCTAssertEqual(visible(["t2"]), ["t", "t1", "t2", "after", "h", "h1", "h2", "next", "plain", "p1"])
    }

    func testAClosedToggleHeadingHidesWhatIsIndentedUnderIt() {
        XCTAssertEqual(visible(["h"]), ["t", "t1", "t2", "t3", "after", "h", "next", "plain", "p1"])
    }

    func testOnlyAToggleFolds() {
        XCTAssertEqual(visible(["plain", "after", "h1"]), blocks.map(\.id))
    }

    func testRevealingABlockOpensEveryToggleOverIt() {
        XCTAssertEqual(NoteFolding.revealing("t3", in: blocks, folded: ["t", "t2", "h"]), ["h"])
        XCTAssertEqual(NoteFolding.revealing("after", in: blocks, folded: ["t"]), ["t"])
    }

    func testAToggleTakesItsChildrenAlongAndOtherBlocksGoAlone() {
        XCTAssertEqual(NoteFolding.withChildren(["t"], in: blocks), ["t", "t1", "t2", "t3"])
        XCTAssertEqual(NoteFolding.withChildren(["h", "t2"], in: blocks), ["t2", "t3", "h", "h1", "h2"])
        XCTAssertEqual(NoteFolding.withChildren(["t1", "plain"], in: blocks), ["t1", "plain"])
    }

    func testOnlyAToggleWithNothingIndentedUnderItIsEmpty() {
        XCTAssertFalse(NoteFolding.isEmpty(at: 0, in: blocks))
        XCTAssertTrue(NoteFolding.isEmpty(at: 0, in: [NoteEditorBlock(id: "t", type: .toggle), blocks[4]]))
        XCTAssertTrue(NoteFolding.isEmpty(at: 0, in: [NoteEditorBlock(id: "t", type: .toggle)]))
    }

    func testABlockInsideAToggleCannotBeOutdentedOutOfIt() {
        XCTAssertEqual(NoteFolding.indentFloor(of: "t1", in: blocks), 1)
        XCTAssertEqual(NoteFolding.indentFloor(of: "t3", in: blocks), 2)
        XCTAssertEqual(NoteFolding.indentFloor(of: "after", in: blocks), 0)
        XCTAssertNil(NoteFolding.applying(.shiftIndent(blockIds: ["t1"], delta: -1), in: blocks))
        let list = [
            NoteEditorBlock(id: "b", type: .bullet),
            NoteEditorBlock(id: "b1", type: .bullet, indent: 1),
            NoteEditorBlock(id: "t", type: .toggle),
            NoteEditorBlock(id: "c", type: .text, indent: 1)
        ]
        XCTAssertEqual(
            NoteFolding.applying(.shiftIndent(blockIds: ["b1", "c"], delta: -1), in: list),
            .shiftIndent(blockIds: ["b1"], delta: -1)
        )
        XCTAssertEqual(
            NoteFolding.applying(.shiftIndent(blockIds: ["t2"], delta: 1), in: blocks),
            .shiftIndent(blockIds: ["t2", "t3"], delta: 1)
        )
    }

    func testOnlyAPlaceUnderAToggleIsInsideIt() {
        XCTAssertTrue(NoteFolding.isInsideToggle(level: 1, before: 4, in: blocks, skipping: []))
        XCTAssertFalse(NoteFolding.isInsideToggle(level: 0, before: 4, in: blocks, skipping: []))
        XCTAssertFalse(NoteFolding.isInsideToggle(level: 1, before: 10, in: blocks, skipping: []))
    }

    func testAToggleHeadingOptionSetsTheHeadingWithItsToggle() {
        let option = NoteMenuKind.style.options.first { $0.type == .heading1 && $0.toggle }
        XCTAssertEqual(
            option?.edits(for: blocks[4]),
            [.setType(blockIds: ["after"], type: .heading1, toggle: true)]
        )
        XCTAssertEqual(NoteMenuKind.list.options.last?.type, .toggle)
    }
}
