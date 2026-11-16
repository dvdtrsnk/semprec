import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the notes bridge's mappings between Kotlin and Swift values with Kotlin values built here,
/// and drives the real Kotlin ViewModel through the bridge. Both modules declare most of these type names, so each is
/// qualified with its module.
final class NotesMappingTests: XCTestCase {

    // MARK: - State
    @MainActor
    func testNotesMapsEveryPhaseAndTheFailure() {
        let phases: [
            (SharedSDK.NotesPhase, CoreKit.NotesPhase)
        ] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedNotesScreenModel.state(notesState(phase: shared)).phase, expected)
        }
        XCTAssertEqual(SharedNotesScreenModel.state(notesState(phase: .error, failure: .notFound)).failure, .notFound)
        XCTAssertNil(SharedNotesScreenModel.state(notesState(phase: .error)).failure)
    }

    @MainActor
    func testNotesMapsEveryBlockTypeBothWays() {
        for type in CoreKit.NoteBlockType.allCases {
            XCTAssertEqual(SharedNotesScreenModel.blockType(SharedNotesScreenModel.sharedBlockType(type)), type)
        }
        XCTAssertEqual(CoreKit.NoteBlockType.allCases.count, 9)
    }

    @MainActor
    func testNotesMapsTheBlocksTheSelectionAndTheWriteFailure() {
        let state = SharedNotesScreenModel.state(
            notesState(
                phase: .content,
                blocks: [
                    SharedSDK.NoteBlockItem(
                        id: "b1", type: .number, indent: 1, done: false, text: "a **b**", pageId: nil, marker: "2.1."
                    ),
                    SharedSDK.NoteBlockItem(
                        id: "b2",
                        type: .page,
                        indent: 0,
                        done: false,
                        text: "Sub",
                        pageId: "p1",
                        marker: nil
                    ),
                    SharedSDK.NoteBlockItem(
                        id: "b3",
                        type: .todo,
                        indent: 0,
                        done: true,
                        text: "x",
                        pageId: nil,
                        marker: nil
                    )
                ],
                writeFailure: SharedSDK.Failed(kind: .rejected)
            )
        )
        XCTAssertEqual(state.title, "Notes")
        XCTAssertEqual(
            state.blocks,
            [
                NoteBlockItem(
                    id: "b1",
                    type: .number,
                    indent: 1,
                    done: false,
                    text: "a **b**",
                    pageId: nil,
                    marker: "2.1."
                ),
                NoteBlockItem(id: "b2", type: .page, indent: 0, done: false, text: "Sub", pageId: "p1", marker: nil),
                NoteBlockItem(id: "b3", type: .todo, indent: 0, done: true, text: "x", pageId: nil, marker: nil)
            ]
        )
        XCTAssertTrue(state.selecting)
        XCTAssertEqual(state.selected, ["b2"])
        XCTAssertTrue(state.working)
        XCTAssertEqual(state.writeFailure, Failed(kind: .rejected))
    }

    // MARK: - Actions and effects
    @MainActor
    func testNotesMapsEachAction() throws {
        XCTAssertTrue(SharedNotesScreenModel.action(.retry) is SharedSDK.NotesActionRetry)
        XCTAssertTrue(SharedNotesScreenModel.action(.refresh) is SharedSDK.NotesActionRefresh)
        XCTAssertTrue(SharedNotesScreenModel.action(.toggleSelecting) is SharedSDK.NotesActionToggleSelecting)
        XCTAssertTrue(
            SharedNotesScreenModel.action(.moveSelectedToSubpages) is SharedSDK.NotesActionMoveSelectedToSubpages
        )
        XCTAssertTrue(SharedNotesScreenModel.action(.openAsText) is SharedSDK.NotesActionOpenAsText)
        XCTAssertTrue(SharedNotesScreenModel.action(.dismissFailure) is SharedSDK.NotesActionDismissFailure)
        let add = try XCTUnwrap(
            SharedNotesScreenModel.action(.add(.todo, text: "x", afterBlockId: "b0")) as? SharedSDK.NotesActionAdd
        )
        XCTAssertEqual(add.type, .todo)
        XCTAssertEqual(add.text, "x")
        XCTAssertEqual(add.afterBlockId, "b0")
        let subpage = try XCTUnwrap(
            SharedNotesScreenModel.action(
                .createSubpage(title: "T", afterBlockId: nil)
            ) as? SharedSDK.NotesActionCreateSubpage
        )
        XCTAssertEqual(subpage.title, "T")
        XCTAssertNil(subpage.afterBlockId)
        let toggle = try XCTUnwrap(
            SharedNotesScreenModel.action(.toggle(blockId: "b1")) as? SharedSDK.NotesActionToggle
        )
        XCTAssertEqual(toggle.blockId, "b1")
        let open = try XCTUnwrap(SharedNotesScreenModel.action(.open(blockId: "b2")) as? SharedSDK.NotesActionOpen)
        XCTAssertEqual(open.blockId, "b2")
        let convert = try XCTUnwrap(
            SharedNotesScreenModel.action(
                .convertToBlock(blockId: "b2", type: .bullet)
            ) as? SharedSDK.NotesActionConvertToBlock
        )
        XCTAssertEqual(convert.blockId, "b2")
        XCTAssertEqual(convert.type, .bullet)
        let rename = try XCTUnwrap(
            SharedNotesScreenModel.action(
                .renameSubpage(blockId: "b2", title: "N")
            ) as? SharedSDK.NotesActionRenameSubpage
        )
        XCTAssertEqual(rename.title, "N")
    }

    @MainActor
    func testNotesMapsEachEffect() {
        XCTAssertEqual(
            SharedNotesScreenModel.effect(SharedSDK.NotesEffectOpenPage(itemId: "p1")),
            .openPage(itemId: "p1")
        )
        XCTAssertEqual(SharedNotesScreenModel.effect(SharedSDK.NotesEffectOpenAsText.shared), .openAsText)
    }

    // MARK: - The real ViewModel
    @MainActor
    func testWithoutASessionTheNotesEndInTheUnauthorizedFailureAndOpenAsTextNeedsNoData() async {
        let model = SharedScreenModelFactory().makeNotes(itemId: "i1")
        model.send(.openAsText)
        var iterator = model.effects().makeAsyncIterator()
        let effect = await iterator.next()
        XCTAssertEqual(effect, .openAsText)
        let reached = XCTestExpectation(description: "The notes failed")
        let observer = Task { @MainActor in
            for await state in model.states() where state.phase == .error {
                XCTAssertEqual(state.failure, .unauthorized)
                reached.fulfill()
                return
            }
        }
        await fulfillment(of: [reached], timeout: 5)
        observer.cancel()
    }

    @MainActor
    func testReleasingTheNotesBridgeClosesTheKotlinViewModel() throws {
        var model: SharedNotesScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeNotes(itemId: "i1") as? SharedNotesScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }
}

// MARK: - Kotlin values
private func notesState(
    phase: SharedSDK.NotesPhase,
    failure: SharedSDK.FailureKind? = nil,
    blocks: [SharedSDK.NoteBlockItem] = [],
    writeFailure: SharedSDK.Failed? = nil
) -> SharedSDK.NotesState {
    SharedSDK.NotesState(
        phase: phase,
        failure: failure,
        title: "Notes",
        blocks: blocks,
        selecting: true,
        selected: ["b2"],
        working: true,
        writeFailure: writeFailure
    )
}
