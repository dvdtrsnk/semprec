import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarSleepBandTests: XCTestCase {

    // MARK: - Tests
    func testAPartOfTheDayIsABand() {
        XCTAssertEqual(sleep(from: 1_380, until: 1_440).band, 1_380..<1_440)
        XCTAssertEqual(sleep(from: 0, until: 405).band, 0..<405)
    }

    func testADayThatHoldsNoneOfTheNightHasNoBand() {
        XCTAssertNil(sleep(from: 0, until: 0).band, "The evening of a night that starts after midnight")
        XCTAssertNil(sleep(from: 600, until: 600).band)
    }

    @MainActor
    func testTheSampleNightOfThePreviewsHasABandOnEachDay() {
        XCTAssertEqual(CalendarPreviewData.sleep.band, 1_380..<1_440)
        XCTAssertEqual(CalendarPreviewData.morningSleep.band, 0..<405)
    }

    func testADayDrawsTheEveningBandAndItsReminderThenTheMorningBand() {
        let evening = sleep(from: 1_380, until: 1_440, prep: 1_350)
        let morning = sleep(from: 0, until: 405)
        let day = CalendarDayState(date: "2026-10-16", items: [], sleepEvening: evening, sleepMorning: morning)

        XCTAssertEqual(
            day.sleepParts,
            [
                .band(evening, 1_380..<1_440, isEvening: true), .reminder(evening, minutes: 1_350),
                .band(morning, 0..<405, isEvening: false)
            ]
        )
    }

    func testAReminderAfterMidnightIsDrawnOnTheMorningAndAnEmptyBandOnlyKeepsIt() {
        let morning = sleep(from: 0, until: 0, prep: 30)
        let day = CalendarDayState(date: "2026-10-16", items: [], sleepEvening: nil, sleepMorning: morning)

        XCTAssertEqual(day.sleepParts, [.reminder(morning, minutes: 30)])
    }

    func testADayWithoutSleepDrawsNothing() {
        XCTAssertTrue(CalendarDayState(date: "2026-10-16", items: []).sleepParts.isEmpty)
        let empty = sleep(from: 600, until: 600)
        XCTAssertTrue(
            CalendarDayState(date: "2026-10-16", items: [], sleepEvening: empty, sleepMorning: empty).sleepParts.isEmpty
        )
    }

    // MARK: - Helpers
    private func sleep(from start: Int, until end: Int, prep: Int? = nil) -> CalendarSleep {
        CalendarSleep(
            night: "2026-10-16", bedMinutes: 1_380, wakeMinutes: 405, alarm: true, changed: false, prepMinutes: prep,
            fromMinutes: start, toMinutes: end
        )
    }
}
