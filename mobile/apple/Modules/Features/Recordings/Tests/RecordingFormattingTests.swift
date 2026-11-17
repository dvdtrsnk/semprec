import XCTest

@testable import RecordingsFeature

final class RecordingFormattingTests: XCTestCase {

    private let english = Locale(identifier: "en_US")
    private let prague = TimeZone(identifier: "Europe/Prague") ?? .gmt

    func testTheClockShowsMinutesBelowAnHourAndHoursFromOneOn() {
        XCTAssertEqual(RecordingFormatting.clock(0), "0:00")
        XCTAssertEqual(RecordingFormatting.clock(65), "1:05")
        XCTAssertEqual(RecordingFormatting.clock(3_599), "59:59")
        XCTAssertEqual(RecordingFormatting.clock(4_867), "1:21:07")
        XCTAssertEqual(RecordingFormatting.clock(-5), "0:00")
    }

    func testAMomentReadsAnISODateTimeWithOrWithoutFractionsAndNothingElse() {
        XCTAssertNotNil(RecordingFormatting.moment("2026-10-16T10:02:00+02:00"))
        XCTAssertNotNil(RecordingFormatting.moment("2026-10-16T08:02:00.123Z"))
        XCTAssertNil(RecordingFormatting.moment("yesterday"))
        XCTAssertNil(RecordingFormatting.moment(nil))
        XCTAssertEqual(
            RecordingFormatting.moment("2026-10-16T10:02:00+02:00"),
            RecordingFormatting.moment("2026-10-16T08:02:00Z")
        )
    }

    func testWhenAndDayAreWrittenInTheGivenZone() throws {
        let when = try XCTUnwrap(RecordingFormatting.when("2026-10-16T08:02:00Z", locale: english, timeZone: prague))
        XCTAssertTrue(when.contains("10:02"), when)
        XCTAssertTrue(when.contains("Fri"), when)
        let day = try XCTUnwrap(RecordingFormatting.day("2026-10-16T23:30:00Z", locale: english, timeZone: prague))
        XCTAssertTrue(day.contains("17"), day)
        XCTAssertNil(RecordingFormatting.when(nil))
        XCTAssertNil(RecordingFormatting.day("nonsense"))
    }

    func testTheLanguageIsNamedInTheLocaleAndAMissingOneIsNil() {
        XCTAssertEqual(RecordingFormatting.language("cs", locale: english), "Czech")
        XCTAssertNil(RecordingFormatting.language(nil))
        XCTAssertNil(RecordingFormatting.language(""))
    }

    func testAnEventDayIsWrittenOutAndTimesJoinOrFallBackToAllDay() throws {
        let day = try XCTUnwrap(RecordingFormatting.eventDay("2026-10-16", locale: english))
        XCTAssertTrue(day.contains("Friday"), day)
        XCTAssertTrue(day.contains("October"), day)
        XCTAssertNil(RecordingFormatting.eventDay(nil))
        XCTAssertNil(RecordingFormatting.eventDay("garbage"))
        XCTAssertEqual(RecordingFormatting.eventTimes(from: "10:00", to: "11:30"), "10:00\u{2013}11:30")
        XCTAssertEqual(RecordingFormatting.eventTimes(from: "10:00", to: nil), "10:00")
        XCTAssertNil(RecordingFormatting.eventTimes(from: nil, to: "11:30"))
    }

    func testADueDateIsShortAndATextThatIsNoDateStaysAsItCame() throws {
        let due = try XCTUnwrap(RecordingFormatting.due("2026-10-23", locale: english))
        XCTAssertTrue(due.contains("23"), due)
        XCTAssertEqual(RecordingFormatting.due("next week"), "next week")
        XCTAssertNil(RecordingFormatting.due(nil))
    }

    func testInitialsAreTheFirstLettersOfTheFirstTwoWords() {
        XCTAssertEqual(RecordingFormatting.initials("jana kovarova"), "JK")
        XCTAssertEqual(RecordingFormatting.initials("Petr"), "P")
        XCTAssertEqual(RecordingFormatting.initials("Karel Jan Zlaty"), "KJ")
        XCTAssertEqual(RecordingFormatting.initials(""), "")
    }
}
