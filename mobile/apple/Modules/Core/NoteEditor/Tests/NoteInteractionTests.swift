import CoreKit
import XCTest

@testable import NoteEditor

@MainActor
final class NoteInteractionTests: XCTestCase {

    private let blocks = [
        NoteEditorBlock(id: "a", type: .text),
        NoteEditorBlock(id: "b", type: .bullet, indent: 1),
        NoteEditorBlock(id: "c", type: .text),
        NoteEditorBlock(id: "p", type: .page, pageId: "page-1")
    ]

    private func interaction() -> NoteInteraction {
        let interaction = NoteInteraction()
        interaction.rowFrames = Dictionary(uniqueKeysWithValues: blocks.enumerated().map { index, block in
            (block.id, CGRect(x: 0, y: CGFloat(index) * 40, width: 300, height: 40))
        })
        return interaction
    }

    /// Drags on `block` by `width` sideways and `height` along the page, the finger at `top` in the page.
    private func drag(
        _ interaction: NoteInteraction,
        _ block: NoteEditorBlock,
        _ width: CGFloat,
        _ height: CGFloat,
        at top: CGFloat
    ) {
        interaction.dragged(
            block,
            by: CGSize(width: width, height: height),
            at: CGPoint(x: width, y: top)
        )
    }

    func testTheThresholdsReachTheStepsOnEachSide() {
        XCTAssertNil(NoteSwipeStep.reached(39))
        XCTAssertEqual(NoteSwipeStep.reached(40), .indent)
        XCTAssertEqual(NoteSwipeStep.reached(105), .listMenu)
        XCTAssertEqual(NoteSwipeStep.reached(190), .styleMenu)
        XCTAssertEqual(NoteSwipeStep.reached(-40), .outdent)
        XCTAssertEqual(NoteSwipeStep.reached(-105), .todo)
        XCTAssertEqual(NoteSwipeStep.reached(-190), .select)
        XCTAssertEqual(NoteSwipeStep.reached(190, editing: true), .indent)
    }

    func testAStepThatCannotApplyDoesNothing() {
        let interaction = interaction()
        drag(interaction, blocks[0], -60, 0, at: 0)
        XCTAssertEqual(interaction.swipe?.step, .outdent)
        XCTAssertEqual(interaction.released(blocks[0]), [])
        XCTAssertFalse(NoteSwipeStep.listMenu.isValid(for: blocks[3]))
    }

    func testReleasedStepsEditTheBlockOrSelectIt() {
        let interaction = interaction()
        drag(interaction, blocks[1], 60, 0, at: 0)
        XCTAssertEqual(interaction.released(blocks[1]), [.shiftIndent(blockIds: ["b"], delta: 1)])
        drag(interaction, blocks[1], -60, 0, at: 0)
        XCTAssertEqual(interaction.released(blocks[1]), [.shiftIndent(blockIds: ["b"], delta: -1)])
        drag(interaction, blocks[2], -120, 0, at: 0)
        XCTAssertEqual(interaction.released(blocks[2]), [.toggleType(blockIds: ["c"], type: .todo)])
        drag(interaction, blocks[2], -200, 0, at: 0)
        XCTAssertEqual(interaction.released(blocks[2]), [])
        XCTAssertTrue(interaction.selecting)
        XCTAssertEqual(interaction.selected, ["c"])
    }

    func testLeavingTheBlockFreezesTheSwipeAndTheOptionAsFarAsTheFingerApplies() {
        let interaction = interaction()
        drag(interaction, blocks[2], 120, 0, at: 100)
        drag(interaction, blocks[2], 120, 40, at: 140)
        XCTAssertEqual(interaction.menu?.kind, .list)
        XCTAssertEqual(interaction.menu?.below, true)
        XCTAssertEqual(interaction.menu?.highlighted, 0)
        drag(interaction, blocks[2], 150, 126, at: 226)
        XCTAssertEqual(interaction.swipe, NoteSwipeState(blockId: "c", translation: 120, step: .listMenu, frozen: true))
        XCTAssertEqual(interaction.menu?.highlighted, 2)
        XCTAssertEqual(
            interaction.released(blocks[2]),
            [.setType(blockIds: ["c"], type: .number)]
        )
        XCTAssertNil(interaction.menu)
        XCTAssertNil(interaction.swipe)
    }

    func testAMenuWithoutRoomOnTheFingersSideOpensOnTheOtherSideMirrored() {
        let interaction = interaction()
        interaction.visible = CGRect(x: 0, y: 0, width: 300, height: 200)
        drag(interaction, blocks[2], 120, 0, at: 100)
        drag(interaction, blocks[2], 120, 88, at: 188)
        XCTAssertEqual(interaction.menu?.below, false)
        XCTAssertEqual(interaction.menu?.highlighted, 1)
    }

    func testBackOnTheBlockTheMenuClosesAndASwipePulledBackChangesNothing() {
        let interaction = interaction()
        drag(interaction, blocks[2], 120, 0, at: 100)
        drag(interaction, blocks[2], 120, 60, at: 160)
        XCTAssertNotNil(interaction.menu)
        drag(interaction, blocks[2], 20, 0, at: 100)
        XCTAssertNil(interaction.menu)
        XCTAssertEqual(interaction.swipe?.frozen, false)
        XCTAssertNil(interaction.swipe?.step)
        XCTAssertEqual(interaction.released(blocks[2]), [])
    }

    func testAGestureTheSystemTookOverStopsWithoutAChangeAndLeavesThePageScrollable() {
        let interaction = interaction()
        drag(interaction, blocks[2], 120, 0, at: 100)
        drag(interaction, blocks[2], 120, 60, at: 160)
        XCTAssertTrue(interaction.isActive)
        interaction.cancelled()
        XCTAssertNil(interaction.swipe)
        XCTAssertNil(interaction.menu)
        XCTAssertFalse(interaction.isActive)
    }

    func testOnALongBlockTheMenuOpensNearWhereTheSwipeStarted() {
        let interaction = NoteInteraction()
        let long = NoteEditorBlock(id: "l", type: .text)
        interaction.rowFrames = ["l": CGRect(x: 0, y: 0, width: 300, height: 400)]
        drag(interaction, long, 120, 0, at: 100)
        drag(interaction, long, 120, 40, at: 140)
        XCTAssertEqual(interaction.menu?.row.maxY, 122)
        XCTAssertEqual(interaction.menu?.highlighted, 0)
    }

    func testAnEditedBlockSwipedShowsAndChangesOnlyItsIndent() {
        let interaction = interaction()
        interaction.dragged(blocks[1], by: CGSize(width: 50, height: 0), at: .zero, editing: true)
        XCTAssertEqual(interaction.swipe?.step, .indent)
        XCTAssertEqual(interaction.released(blocks[1]), [.shiftIndent(blockIds: ["b"], delta: 1)])
        interaction.dragged(blocks[1], by: CGSize(width: 20, height: 0), at: .zero, editing: true)
        XCTAssertEqual(interaction.released(blocks[1]), [])
    }

    func testAHeldBlockLetGoSelectsItAndAHeldBlockDraggedMovesIt() {
        let interaction = interaction()
        interaction.hold(blocks[0])
        XCTAssertEqual(interaction.holds, 1)
        XCTAssertEqual(interaction.holdEnded(in: blocks), [])
        XCTAssertTrue(interaction.selecting)
        XCTAssertEqual(interaction.selected, ["a"])
        interaction.stopSelecting()
        interaction.hold(blocks[0])
        interaction.holdMoved(blocks[0], to: CGPoint(x: 10, y: 20), in: blocks)
        interaction.holdMoved(blocks[0], to: CGPoint(x: 10, y: 110), in: blocks)
        XCTAssertEqual(interaction.drag?.target, 3)
        XCTAssertEqual(interaction.holdEnded(in: blocks), [.move(blockIds: ["a"], targetIndex: 3)])
        XCTAssertFalse(interaction.selecting)
        XCTAssertNil(interaction.held)
    }

    func testADraggedToggleMovesWithItsChildren() {
        let notes = [
            NoteEditorBlock(id: "t", type: .toggle),
            NoteEditorBlock(id: "c", type: .text, indent: 1),
            NoteEditorBlock(id: "x", type: .text),
            NoteEditorBlock(id: "y", type: .text)
        ]
        let interaction = NoteInteraction()
        interaction.rowFrames = Dictionary(uniqueKeysWithValues: notes.enumerated().map { index, block in
            (block.id, CGRect(x: 0, y: CGFloat(index) * 40, width: 300, height: 40))
        })
        interaction.hold(notes[0])
        interaction.holdMoved(notes[0], to: CGPoint(x: 10, y: 20), in: notes)
        interaction.holdMoved(notes[0], to: CGPoint(x: 10, y: 150), in: notes)
        XCTAssertEqual(interaction.holdEnded(in: notes), [.move(blockIds: ["t", "c"], targetIndex: 4)])
    }

    /// Holds the last of `notes` and drags it to `location`, every row 40 high; the edits its drop asks for.
    private func drop(
        _ notes: [NoteEditorBlock],
        at location: CGPoint,
        hidden: Set<String> = []
    ) -> [NoteEditorBlockEdit] {
        let interaction = NoteInteraction()
        interaction.rowFrames = Dictionary(uniqueKeysWithValues: notes.enumerated().compactMap { index, row in
            hidden.contains(row.id) ? nil : (row.id, CGRect(x: 0, y: CGFloat(index) * 40, width: 300, height: 40))
        })
        guard let held = notes.last else { return [] }
        interaction.hold(held)
        interaction.holdMoved(held, to: CGPoint(x: 100, y: 0), in: notes)
        interaction.holdMoved(held, to: location, in: notes)
        return interaction.holdEnded(in: notes)
    }

    func testABlockDroppedIntoAToggleTakesItsLevel() {
        let notes = [
            NoteEditorBlock(id: "t", type: .toggle),
            NoteEditorBlock(id: "c1", type: .text, indent: 1),
            NoteEditorBlock(id: "c2", type: .text, indent: 1),
            NoteEditorBlock(id: "x", type: .text),
            NoteEditorBlock(id: "y", type: .text)
        ]
        // Right under the open toggle and between its children it goes inside.
        let inside = { (target: Int) in
            [NoteEditorBlockEdit.move(blockIds: ["y"], targetIndex: target, indentDelta: 1)]
        }
        XCTAssertEqual(drop(notes, at: CGPoint(x: 100, y: 30)), inside(1))
        XCTAssertEqual(drop(notes, at: CGPoint(x: 100, y: 70)), inside(2))
        // After the last child it stays outside, unless the finger goes right by a level.
        XCTAssertEqual(drop(notes, at: CGPoint(x: 100, y: 110)), [.move(blockIds: ["y"], targetIndex: 3)])
        XCTAssertEqual(drop(notes, at: CGPoint(x: 130, y: 110)), inside(3))
        // Under a closed toggle it goes after its children, beside it.
        XCTAssertEqual(
            drop(notes, at: CGPoint(x: 100, y: 110), hidden: ["c1", "c2"]),
            [.move(blockIds: ["y"], targetIndex: 3)]
        )
    }

    func testAMenuLeftWithoutAChoiceStaysOpenForATap() {
        let interaction = interaction()
        drag(interaction, blocks[0], 200, 0, at: 20)
        XCTAssertEqual(interaction.released(blocks[0]), [])
        XCTAssertEqual(interaction.menu?.kind, .style)
        XCTAssertEqual(interaction.menu?.pinned, true)
        let quote = NoteMenuKind.style.options.first { $0.type == .quote }
        XCTAssertEqual(quote.map { interaction.pick($0, for: blocks[0]) }, [.setType(blockIds: ["a"], type: .quote)])
        XCTAssertNil(interaction.menu)
    }

    func testDraggingSidewaysAndThenAlongThePageSelectsARange() {
        let interaction = interaction()
        interaction.startSelecting(with: "a")
        drag(interaction, blocks[1], 30, 0, at: 60)
        drag(interaction, blocks[1], 30, 60, at: 120)
        XCTAssertEqual(interaction.selected, ["a", "b", "c"])
        _ = interaction.released(blocks[1])
        interaction.toggle("b")
        XCTAssertEqual(interaction.selectedIds(in: blocks), ["a", "c"])
    }

    func testTheHandleMovesTheSelectionAsOneGroupWithOneMove() {
        let interaction = interaction()
        interaction.startSelecting(with: "a")
        interaction.toggle("c")
        interaction.moved(blocks[0], to: CGPoint(x: 10, y: 150), in: blocks)
        XCTAssertEqual(interaction.drag?.blockIds, ["a", "c"])
        XCTAssertEqual(interaction.drag?.target, 4)
        XCTAssertEqual(interaction.dropped(in: blocks), [.move(blockIds: ["a", "c"], targetIndex: 4)])
        XCTAssertNil(interaction.drag)
    }

    func testBlocksDroppedWhereTheyAreStayPut() {
        let interaction = interaction()
        interaction.moved(blocks[1], to: CGPoint(x: 10, y: 50), in: blocks)
        XCTAssertEqual(interaction.dropped(in: blocks), [])
    }
}
