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

    private func drag(bed: Int, wake: Int, duration: Int = 0, meetsGoal: Bool? = nil) -> CalendarSleepDrag {
        CalendarSleepDrag(
            night: "2026-10-16", bedMinutes: bed, wakeMinutes: wake, committing: false,
            durationMinutes: duration, meetsGoal: meetsGoal
        )
    }

    // MARK: - Tests
    func testANightMovedFromItsPlanIsChangedAndOneMovedBackIsNot() {
        let planned = night(planBed: 23 * 60, planWake: 7 * 60)
        XCTAssertTrue(planned.moved(by: drag(bed: 23 * 60 + 30, wake: 7 * 60 + 30)).changed)
        XCTAssertFalse(planned.moved(by: drag(bed: 23 * 60, wake: 7 * 60)).changed)
    }

    func testANightWithoutAPlanIsNeverChangedFromIt() {
        XCTAssertFalse(night(planBed: nil, planWake: nil).moved(by: drag(bed: 22 * 60, wake: 6 * 60)).changed)
    }

    func testTheLengthAndTheGoalAreTheSharedLayers() {
        let moved = night(planBed: nil, planWake: nil)
            .moved(by: drag(bed: 23 * 60 + 30, wake: 6 * 60, duration: 6 * 60 + 30, meetsGoal: false))
        XCTAssertEqual(moved.durationMinutes, 6 * 60 + 30)
        XCTAssertEqual(moved.meetsGoal, false)
        XCTAssertEqual(moved.goalMinutes, 480)
    }
}
