import CoreKit
import SwiftUI
import XCTest

@testable import JournalFeature

final class JournalFormattingTests: XCTestCase {

    // MARK: - Colors
    func testHexColorsAreReadAndBadOnesRefused() {
        XCTAssertNotNil(Color(hex: "#007AFF"))
        XCTAssertNotNil(Color(hex: "AF52DE"))
        XCTAssertNil(Color(hex: "#FFF"))
        XCTAssertNil(Color(hex: "not a color"))
        XCTAssertNil(Color(hex: ""))
    }

    // MARK: - Dates
    @MainActor
    func testAPeriodIsShiftedByItsOwnLengthAcrossTheEndsOfMonthsAndYears() {
        XCTAssertEqual(JournalDates.shifted("2026-12-31", kind: .day, by: 1), "2027-01-01")
        XCTAssertEqual(JournalDates.shifted("2026-03-01", kind: .day, by: -1), "2026-02-28")
        // A week across the change to summer time in Europe is still seven days.
        XCTAssertEqual(JournalDates.shifted("2026-03-23", kind: .week, by: 1), "2026-03-30")
        XCTAssertEqual(JournalDates.shifted("2026-12-01", kind: .month, by: 1), "2027-01-01")
        XCTAssertEqual(JournalDates.shifted("2026-01-01", kind: .month, by: -1), "2025-12-01")
        XCTAssertEqual(JournalDates.shifted("2026-10-01", kind: .quarter, by: 1), "2027-01-01")
        XCTAssertEqual(JournalDates.shifted("2026-01-01", kind: .quarter, by: -1), "2025-10-01")
        XCTAssertEqual(JournalDates.shifted("2026-01-01", kind: .year, by: 1), "2027-01-01")
        XCTAssertEqual(JournalDates.shifted("2026-01-01", kind: .year, by: -3), "2023-01-01")
    }

    @MainActor
    func testAStartThatIsNoDayCannotBeShifted() {
        XCTAssertNil(JournalDates.shifted("not a day", kind: .day, by: 1))
        XCTAssertNil(JournalDates.shifted("2026-10", kind: .month, by: 1))
    }

    // MARK: - Page turns
    func testTheFingerTurnsThePagePastAThirdOfTheWidthOrWithAFlickTheWayItMoved() {
        XCTAssertEqual(JournalPagerRules.turn(offset: -150, width: 400, speed: 0), 1)
        XCTAssertEqual(JournalPagerRules.turn(offset: 150, width: 400, speed: 0), -1)
        XCTAssertNil(JournalPagerRules.turn(offset: -130, width: 400, speed: 0))
        XCTAssertEqual(JournalPagerRules.turn(offset: -40, width: 400, speed: -800), 1)
        XCTAssertEqual(JournalPagerRules.turn(offset: 40, width: 400, speed: 800), -1)
        // A flick against the way the page moved springs back.
        XCTAssertNil(JournalPagerRules.turn(offset: -40, width: 400, speed: 800))
        XCTAssertNil(JournalPagerRules.turn(offset: -40, width: 400, speed: -400), "Too slow for a flick")
        XCTAssertNil(JournalPagerRules.turn(offset: 0, width: 400, speed: -900))
        XCTAssertNil(JournalPagerRules.turn(offset: -300, width: 0, speed: 0), "No width, no turn")
    }

    func testTheSlotThatLeftTheViewGoesRoundToTheOtherSide() {
        XCTAssertEqual(JournalPagerRules.places([-1, 0, 1], afterTurning: 1), [1, -1, 0])
        XCTAssertEqual(JournalPagerRules.places([1, -1, 0], afterTurning: -1), [-1, 0, 1])
        XCTAssertEqual(JournalPagerRules.places([-1, 0, 1], afterTurning: -1), [0, 1, -1])
        XCTAssertEqual(JournalPagerRules.places([-1, 0, 1], afterTurning: 0), [-1, 0, 1])
    }

    @MainActor
    func testTheDeviceDayIsWrittenAsAnIsoDay() throws {
        var parts = DateComponents()
        parts.year = 2026
        parts.month = 3
        parts.day = 5
        parts.hour = 23
        let date = try XCTUnwrap(Calendar.current.date(from: parts))
        XCTAssertEqual(JournalDates.deviceToday(now: date), "2026-03-05")
    }

    @MainActor
    func testDaysAreParsedAndImpossibleOnesRefused() {
        XCTAssertNotNil(JournalDates.date("2026-10-16"))
        XCTAssertNil(JournalDates.date("2026-10"))
        XCTAssertNil(JournalDates.date("soon"))
        XCTAssertEqual(JournalDates.year("2026-10-16"), 2026)
        XCTAssertEqual(JournalDates.year("soon"), 0)
    }

    @MainActor
    func testTitlesNameTheDayMonthAndQuarter() {
        XCTAssertEqual(JournalDates.dayTitle("2026-10-16"), "Friday, October 16")
        XCTAssertEqual(JournalDates.monthTitle("2026-10-01"), "October 2026")
        XCTAssertEqual(JournalDates.quarterTitle(start: "2026-10-01"), "Q4 2026")
        XCTAssertEqual(JournalDates.quarterTitle(start: "2026-01-01"), "Q1 2026")
        XCTAssertEqual(JournalDates.quarterSpan(start: "2026-10-01"), "October – December")
        XCTAssertEqual(JournalDates.dayTitle("soon"), "soon")
    }

    @MainActor
    func testAxisLabelsFollowTheIsoWeekdayAndMonth() {
        XCTAssertEqual(JournalDates.weekdayShort(1), "Mon")
        XCTAssertEqual(JournalDates.weekdayShort(7), "Sun")
        XCTAssertEqual(JournalDates.monthShort(1), "Jan")
        XCTAssertEqual(JournalDates.monthShort(12), "Dec")
    }

    @MainActor
    func testClockAndWeekRange() {
        XCTAssertEqual(JournalDates.clock(minutes: 545), "9:05")
        XCTAssertEqual(JournalDates.clock(minutes: 0), "0:00")
        XCTAssertFalse(JournalDates.weekRange(first: "2026-10-12", last: "2026-10-18").isEmpty)
        XCTAssertEqual(JournalDates.weekRange(first: "x", last: "y"), "x – y")
    }

    // MARK: - Copy
    func testFailureMessagesAreTranslatedToCzech() throws {
        let czech = try czechBundle()
        let message = { (key: String) in czech.localizedString(forKey: key, value: nil, table: nil) }
        XCTAssertEqual(message("failure.unavailable"), "Obsah teď není dostupný.")
        XCTAssertEqual(message("failure.unexpected"), "Něco se pokazilo.")
        XCTAssertEqual(FailureKind.message(for: .notFound), "This could not be found.")
        XCTAssertEqual(FailureKind.message(for: nil), "Something went wrong.")
    }

    func testTheBoardsCzechTextsAreInTheCatalog() throws {
        let czech = try czechBundle()
        let message = { (key: String) in czech.localizedString(forKey: key, value: nil, table: nil) }
        XCTAssertEqual(message("journal.title"), "Deník")
        XCTAssertEqual(message("journal.today"), "Dnes")
        XCTAssertEqual(message("journal.events.none"), "Žádné události")
        XCTAssertEqual(message("journal.week"), "Týden %lld")
        XCTAssertEqual(message("journal.subtitle.month"), "Týdny v měsíci")
    }

    // MARK: - Helpers
    private func czechBundle() throws -> Bundle {
        let path = try XCTUnwrap(Bundle.module.path(forResource: "cs", ofType: "lproj"))
        return try XCTUnwrap(Bundle(path: path))
    }
}
