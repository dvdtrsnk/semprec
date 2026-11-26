import CoreKit
import XCTest

@testable import SleepFeature

final class SleepSaveFailureTests: XCTestCase {

    // MARK: - Tests
    func testTheOverviewPresentsAFailureWhileNoEditorIsOpen() {
        var state = SleepState.previewReady
        state.saveFailed = true

        XCTAssertTrue(state.overviewShowsSaveFailure)
    }

    func testAnOpenEditorPresentsTheFailureItselfAndTheOverviewDoesNot() {
        let state = SleepState.previewReady.editing(.previewWeekdays)
        var failed = state
        failed.saveFailed = true

        XCTAssertFalse(failed.overviewShowsSaveFailure)
        XCTAssertNotNil(failed.editor)
    }

    func testOneFailureNeverShowsTwoAlerts() {
        for editing in [false, true] {
            for failed in [false, true] {
                var state = editing ? SleepState.previewReady.editing(.previewNew) : SleepState.previewReady
                state.saveFailed = failed

                XCTAssertFalse(state.overviewShowsSaveFailure && state.editorShowsSaveFailure)
                XCTAssertEqual(state.overviewShowsSaveFailure || state.editorShowsSaveFailure, failed)
            }
        }
    }

    func testWithoutAFailureNothingIsPresented() {
        XCTAssertFalse(SleepState.previewReady.overviewShowsSaveFailure)
        XCTAssertFalse(SleepState.previewReady.editing(.previewNew).overviewShowsSaveFailure)
    }

    // MARK: - Presentation
    func testTheBindingsFollowTheStateAndClosingSendsAnIntent() {
        let sent = Recorder()
        var state = SleepState.previewReady.editing(.previewWeekdays)
        state.saveFailed = true
        let presentation = SleepPresentation(state: state, send: sent.record)

        XCTAssertTrue(presentation.editor.wrappedValue)
        XCTAssertFalse(presentation.overviewFailure.wrappedValue)
        XCTAssertTrue(presentation.editorFailure.wrappedValue)

        presentation.editor.wrappedValue = true
        presentation.editor.wrappedValue = false
        presentation.editorFailure.wrappedValue = false
        presentation.overviewFailure.wrappedValue = false

        XCTAssertEqual(sent.actions, [.draft(.discard), .dismissSaveFailure, .dismissSaveFailure])
    }

    func testWithoutAnEditorTheSheetIsClosedAndTheOverviewShowsTheFailure() {
        var state = SleepState.previewReady
        state.saveFailed = true
        let presentation = SleepPresentation(state: state, send: { _ in })

        XCTAssertFalse(presentation.editor.wrappedValue)
        XCTAssertTrue(presentation.overviewFailure.wrappedValue)
        XCTAssertFalse(presentation.editorFailure.wrappedValue)
    }
}

// MARK: - Support
private final class Recorder {

    private(set) var actions: [SleepAction] = []

    func record(_ action: SleepAction) {
        actions.append(action)
    }
}
