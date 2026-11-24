import CoreKit
import XCTest

@testable import JournalFeature

final class JournalPageHoldTests: XCTestCase {

    private let monday = JournalState(
        phase: .content, selection: JournalSelection(kind: .day, start: "2026-11-23"), today: "2026-11-24"
    )
    private let tuesday = JournalState(
        phase: .content, selection: JournalSelection(kind: .day, start: "2026-11-24"), today: "2026-11-24"
    )

    func testTheAxisHoldsThePageItStartedWithUntilItRests() {
        var hold = JournalPageHold()
        hold.axisMoved(true, showing: monday)
        XCTAssertEqual(hold.held, monday)
        hold.axisMoved(true, showing: tuesday)
        XCTAssertEqual(hold.held, monday, "What was held first stays held")
        hold.axisMoved(false, showing: tuesday)
        XCTAssertNil(hold.held)
    }

    func testATurnHoldsNothingAndTheAxisMovingDuringItDoesNotHoldEither() {
        var hold = JournalPageHold()
        hold.axisMoved(true, showing: monday)
        hold.turnStarted()
        XCTAssertTrue(hold.isTurning)
        XCTAssertNil(hold.held, "A turn lets the new period through at once")
        hold.axisMoved(true, showing: tuesday)
        XCTAssertNil(hold.held)
    }

    func testATurnEndsWhenTheAxisRests() {
        var hold = JournalPageHold()
        hold.turnStarted()
        hold.axisMoved(true, showing: monday)
        hold.periodShown(axisMoving: true)
        XCTAssertTrue(hold.isTurning, "The axis still moves to the period")
        hold.axisMoved(false, showing: tuesday)
        XCTAssertFalse(hold.isTurning)
        hold.axisMoved(true, showing: tuesday)
        XCTAssertEqual(hold.held, tuesday, "After the turn the axis holds the page again")
    }

    func testATurnTheAxisDoesNotMoveForEndsOnceItsPeriodIsShown() {
        var hold = JournalPageHold()
        hold.turnStarted()
        hold.periodShown(axisMoving: false)
        XCTAssertFalse(hold.isTurning)
        hold.axisMoved(true, showing: monday)
        XCTAssertEqual(hold.held, monday, "The next scroll of the axis holds the page")
    }
}
