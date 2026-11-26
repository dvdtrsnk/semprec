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

    func testTheSampleNightOfThePreviewsHasABandOnEachDay() {
        XCTAssertEqual(CalendarPreviewData.sleep.band, 1_380..<1_440)
        XCTAssertEqual(CalendarPreviewData.morningSleep.band, 0..<405)
    }

    // MARK: - Helpers
    private func sleep(from start: Int, until end: Int) -> CalendarSleep {
        CalendarSleep(
            night: "2026-10-16", bedMinutes: 1_380, wakeMinutes: 405, alarm: true, changed: false, prepMinutes: nil,
            fromMinutes: start, toMinutes: end
        )
    }
}
