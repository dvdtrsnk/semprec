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

    func testWithoutAFailureNothingIsPresented() {
        XCTAssertFalse(SleepState.previewReady.overviewShowsSaveFailure)
        XCTAssertFalse(SleepState.previewReady.editing(.previewNew).overviewShowsSaveFailure)
    }
}
