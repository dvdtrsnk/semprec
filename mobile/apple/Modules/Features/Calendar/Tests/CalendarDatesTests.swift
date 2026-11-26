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

    func testTheIsoWeekNumber() {
        XCTAssertEqual(CalendarDates.isoWeek("2026-11-18"), 47)
        XCTAssertEqual(CalendarDates.isoWeek("2026-11-22"), 47)
        XCTAssertEqual(CalendarDates.isoWeek("2026-11-23"), 48)
        XCTAssertEqual(CalendarDates.isoWeek("2027-01-01"), 53)
        XCTAssertEqual(CalendarDates.isoWeek("2027-01-04"), 1)
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
    func testClockWritesATimeAsTheRegionDoesAndMidnightClosesTheDay() {
        let nineFive = CalendarDates.clock(minutes: 545)
        XCTAssertTrue(nineFive.contains("9"), nineFive)
        XCTAssertTrue(nineFive.contains("05"), nineFive)
        XCTAssertEqual(CalendarDates.clock(minutes: 1440), CalendarDates.clock(minutes: 0))
        XCTAssertNotEqual(CalendarDates.clock(minutes: 0), CalendarDates.clock(minutes: 720))
    }

    func testAnHourLineIsLabelledAsTheRegionWritesHours() {
        let two = CalendarDates.hourLabel(14)
        if DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current)?.contains("a") == true {
            XCTAssertTrue(two.contains("2"), two)
            XCTAssertFalse(two.contains("14"), two)
            XCTAssertFalse(two.contains(":"), two)
        } else {
            XCTAssertEqual(two, CalendarDates.clock(minutes: 14 * 60))
        }
        XCTAssertNotEqual(CalendarDates.hourLabel(0), CalendarDates.hourLabel(12))
        XCTAssertEqual(CalendarDates.hourLabel(14), two)
    }

    func testRangeJoinsTwoClocksWithAnEnDash() {
        let expected = "\(CalendarDates.clock(minutes: 840))–\(CalendarDates.clock(minutes: 930))"
        XCTAssertEqual(CalendarDates.range(from: 840, to: 930), expected)
    }

    func testTheDeviceTodayIsAWellFormedDay() {
        let today = CalendarDates.deviceToday(now: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(today.count, 10)
        XCTAssertNotNil(CalendarDates.date(today))
    }
}
