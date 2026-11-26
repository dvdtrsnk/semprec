import CoreKit
import XCTest

@testable import SleepFeature

/// The tests run in English, so the texts below are the English ones of the String Catalog.
final class SleepFormatTests: XCTestCase {

    // MARK: - Times
    func testATimeIsWrittenWithoutALeadingZeroOnTheHour() {
        XCTAssertEqual(SleepFormat.time(405), "6:45")
        XCTAssertEqual(SleepFormat.time(1_380), "23:00")
        XCTAssertEqual(SleepFormat.time(0), "0:00")
    }

    func testATimeWrapsAroundMidnight() {
        XCTAssertEqual(SleepFormat.time(1_440), "0:00")
        XCTAssertEqual(SleepFormat.time(-30), "23:30")
    }

    // MARK: - Durations
    func testADurationIsWrittenInHoursAndMinutes() {
        XCTAssertEqual(SleepFormat.duration(45), "45 min")
        XCTAssertEqual(SleepFormat.duration(480), "8 h")
        XCTAssertEqual(SleepFormat.duration(465), "7 h 45 min")
    }

    func testAReminderLeadOfOneHourHasItsOwnText() {
        XCTAssertEqual(SleepFormat.lead(30), "30 min before bedtime")
        XCTAssertEqual(SleepFormat.lead(60), "1 h before bedtime")
    }

    func testTheGoalDifferenceTellsAboveBelowAndExact() {
        XCTAssertEqual(SleepFormat.goalDifference(0), "exactly the goal")
        XCTAssertEqual(SleepFormat.goalDifference(30), "+30 min over the goal")
        XCTAssertEqual(SleepFormat.goalDifference(-15), "15 min under the goal")
    }

    // MARK: - Days
    func testTheDaysOfAPlanAreNamedWhenTheyAreTheCommonSets() {
        XCTAssertEqual(SleepFormat.days([5, 4, 3, 2, 1]), "Mon–Fri")
        XCTAssertEqual(SleepFormat.days([7, 6]), "Sat, Sun")
        XCTAssertEqual(SleepFormat.days([1, 2, 3, 4, 5, 6, 7]), "Every day")
    }

    func testOtherDaysAreListedInOrder() {
        XCTAssertEqual(SleepFormat.days([3, 1]), "Mon, Wed")
    }

    func testWeekdayNamesFollowTheIsoNumbers() {
        XCTAssertEqual(SleepFormat.weekdayShort(1), "Mon")
        XCTAssertEqual(SleepFormat.weekdayShort(7), "Sun")
        XCTAssertEqual(SleepFormat.weekdayLong(5), "Friday")
        XCTAssertEqual(SleepFormat.weekdayInitial(1), "M")
        XCTAssertEqual(SleepFormat.weekdayInitial(7), "S")
    }

    // MARK: - Nights
    func testANightIsReadFromItsEveningDate() throws {
        let date = try XCTUnwrap(SleepFormat.date(of: "2026-10-16"))
        let parts = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
        XCTAssertEqual([parts.year, parts.month, parts.day], [2026, 10, 16])
        XCTAssertNil(SleepFormat.date(of: "16.10.2026"))
    }

    func testTheRangeOfANightSpansTheEveningAndTheMorning() throws {
        let range = try XCTUnwrap(SleepFormat.range(of: "2026-10-16"))
        XCTAssertTrue(range.contains("→"))
        XCTAssertTrue(range.contains("16"))
        XCTAssertTrue(range.contains("17"))
        XCTAssertNil(SleepFormat.range(of: "nope"))
    }

    // MARK: - Failures
    func testEveryFailureHasAMessageAndAnUnexpectedOneToo() {
        let kinds: [FailureKind?] = [.unavailable, .invalidData, .unauthorized, .notFound, .rejected, nil]
        let messages = kinds.map { FailureKind.sleepMessage(for: $0) }
        XCTAssertEqual(Set(messages).count, kinds.count, "Each failure must have a message of its own")
        XCTAssertTrue(messages.allSatisfy { !$0.isEmpty && !$0.hasPrefix("sleep.failure.") })
    }

    // MARK: - Sounds
    func testEverySoundHasAName() {
        let names = SleepAlarmSound.allCases.map(\.name)
        XCTAssertEqual(Set(names).count, SleepAlarmSound.allCases.count)
        XCTAssertTrue(names.allSatisfy { !$0.hasPrefix("sleep.sound.") })
        XCTAssertNotNil(SleepAlarmSound.morning.detail)
        XCTAssertNil(SleepAlarmSound.piano.detail)
    }
}
