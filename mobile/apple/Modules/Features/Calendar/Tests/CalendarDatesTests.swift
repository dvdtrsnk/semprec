import XCTest

@testable import CalendarFeature

@MainActor
final class CalendarDatesTests: XCTestCase {

    // MARK: - Parsing
    func testADayRoundTripsThroughADate() throws {
        let date = try XCTUnwrap(CalendarDates.date("2026-10-16"))
        XCTAssertEqual(CalendarDates.key(date), "2026-10-16")
        XCTAssertNil(CalendarDates.date("never"))
    }

    func testShiftingCrossesMonthsAndYears() {
        XCTAssertEqual(CalendarDates.shifted("2026-10-31", by: 1), "2026-11-01")
        XCTAssertEqual(CalendarDates.shifted("2026-01-01", by: -1), "2025-12-31")
        XCTAssertEqual(CalendarDates.shifted("never", by: 1), "never")
    }

    func testTheMondayOfAWeekAndTheDaysBetweenTwoDays() {
        XCTAssertEqual(CalendarDates.monday(of: "2026-11-18"), "2026-11-16")
        XCTAssertEqual(CalendarDates.monday(of: "2026-11-16"), "2026-11-16")
        XCTAssertEqual(CalendarDates.monday(of: "2026-11-22"), "2026-11-16")
        XCTAssertEqual(CalendarDates.monday(of: "2027-01-01"), "2026-12-28")
        XCTAssertEqual(CalendarDates.days(from: "2026-11-16", to: "2026-11-23"), 7)
        XCTAssertEqual(CalendarDates.days(from: "2026-11-16", to: "2026-11-02"), -14)
        XCTAssertEqual(CalendarDates.days(from: "2026-12-28", to: "2027-01-04"), 7)
        XCTAssertEqual(CalendarDates.days(from: "never", to: "2026-11-16"), 0)
    }

    // MARK: - Parts
    func testPartsOfADay() {
        XCTAssertEqual(CalendarDates.dayNumber("2026-10-16"), 16)
        XCTAssertEqual(CalendarDates.isoWeekday("2026-10-16"), 5)
        XCTAssertEqual(CalendarDates.isoWeekday("2026-10-18"), 7)
        XCTAssertEqual(CalendarDates.isoWeekday("2026-10-12"), 1)
        XCTAssertEqual(CalendarDates.year("2026-10-16"), 2026)
        XCTAssertEqual(CalendarDates.month("2026-10-16"), 10)
        XCTAssertEqual(CalendarDates.firstOfMonth("2026-10-16"), "2026-10-01")
        XCTAssertEqual(CalendarDates.firstOfMonth("never"), "never")
    }

    // MARK: - Titles
    func testClockAndRangeFormatMinutes() {
        XCTAssertEqual(CalendarDates.clock(minutes: 545), "9:05")
        XCTAssertEqual(CalendarDates.clock(minutes: 1440), "24:00")
        XCTAssertEqual(CalendarDates.range(from: 840, to: 930), "14:00–15:30")
    }

    func testTheDeviceTodayIsAWellFormedDay() {
        let today = CalendarDates.deviceToday(now: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(today.count, 10)
        XCTAssertNotNil(CalendarDates.date(today))
    }
}
