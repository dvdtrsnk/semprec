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
}
