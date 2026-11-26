import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarSleepMovedTests: XCTestCase {

    // MARK: - Helpers
    private func night(planBed: Int?, planWake: Int?, goal: Int? = 480) -> CalendarSleep {
        CalendarSleep(
            night: "2026-10-16",
            bedMinutes: 23 * 60,
            wakeMinutes: 7 * 60,
            alarm: false,
            changed: false,
            prepMinutes: nil,
            planBedMinutes: planBed,
            planWakeMinutes: planWake,
            durationMinutes: 480,
            goalMinutes: goal,
            meetsGoal: true
        )
    }

    // MARK: - Tests
    func testANightMovedFromItsPlanIsChangedAndOneMovedBackIsNot() {
        let planned = night(planBed: 23 * 60, planWake: 7 * 60)
        XCTAssertTrue(planned.moved(bed: 23 * 60 + 30, wake: 7 * 60 + 30).changed)
        XCTAssertFalse(planned.moved(bed: 23 * 60, wake: 7 * 60).changed)
    }

    func testANightWithoutAPlanIsNeverChangedFromIt() {
        XCTAssertFalse(night(planBed: nil, planWake: nil).moved(bed: 22 * 60, wake: 6 * 60).changed)
    }

    func testTheLengthAndTheGoalAreWorkedOutThroughMidnight() {
        let moved = night(planBed: nil, planWake: nil).moved(bed: 23 * 60 + 30, wake: 6 * 60)
        XCTAssertEqual(moved.durationMinutes, 6 * 60 + 30)
        XCTAssertEqual(moved.meetsGoal, false)
    }
}
