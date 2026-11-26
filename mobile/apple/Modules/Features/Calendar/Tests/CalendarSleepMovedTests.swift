import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarSleepMovedTests: XCTestCase {

    // MARK: - Tests
    func testAMovedNightTakesTheTimesTheLengthTheGoalAndTheChangeOfItsDrag() {
        let night = CalendarSleep(
            night: "2026-10-16",
            bedMinutes: 23 * 60,
            wakeMinutes: 7 * 60,
            alarm: true,
            changed: false,
            prepMinutes: 22 * 60 + 30,
            planBedMinutes: 23 * 60,
            planWakeMinutes: 7 * 60,
            durationMinutes: 480,
            goalMinutes: 480,
            meetsGoal: true
        )
        let drag = CalendarSleepDrag(
            night: "2026-10-16", bedMinutes: 23 * 60 + 30, wakeMinutes: 6 * 60, committing: false,
            durationMinutes: 6 * 60 + 30, meetsGoal: false, changed: true
        )
        let moved = night.moved(by: drag)
        XCTAssertEqual(moved.bedMinutes, 23 * 60 + 30)
        XCTAssertEqual(moved.wakeMinutes, 6 * 60)
        XCTAssertEqual(moved.durationMinutes, 6 * 60 + 30)
        XCTAssertEqual(moved.meetsGoal, false)
        XCTAssertTrue(moved.changed)
        XCTAssertEqual(moved.goalMinutes, 480)
        XCTAssertEqual(moved.planBedMinutes, 23 * 60)
        XCTAssertEqual(moved.prepMinutes, 22 * 60 + 30)
        XCTAssertTrue(moved.alarm)
    }
}
