import CoreKit
import SwiftUI
import XCTest

@testable import OverviewFeature

/// The words and symbols of the overview, in the language of the test scheme (English).
final class FormattingTests: XCTestCase {

    // MARK: - Fixtures
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return calendar
    }()

    private var now: Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 13, minute: 24)) ?? .distantPast
    }

    private var date: DisplayDate {
        DisplayDate(now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
    }

    private func subtitle(_ parts: [SearchSubtitlePart]) -> String {
        SearchSubtitle(date: date, locale: Locale(identifier: "en_US")).text(for: parts)
    }

    private func part(_ kind: SearchSubtitleKind, _ value: String) -> SearchSubtitlePart {
        SearchSubtitlePart(kind: kind, value: value, itemId: nil)
    }

    // MARK: - Dates
    func testTheDayBeforeTodayAndTomorrowAreNamed() {
        XCTAssertEqual(date.text(iso: "2026-10-15"), "Yesterday")
        XCTAssertEqual(date.text(iso: "2026-10-16"), "Today")
        XCTAssertEqual(date.text(iso: "2026-10-17"), "Tomorrow")
    }

    func testAnotherDayIsWrittenByItsWeekdayDayAndMonth() throws {
        let text = try XCTUnwrap(date.text(iso: "2026-10-22"))
        XCTAssertTrue(text.contains("Thu"), text)
        XCTAssertTrue(text.contains("22"), text)
    }

    func testTextThatIsNotADateIsNotWritten() {
        XCTAssertNil(date.text(iso: ""))
        XCTAssertNil(date.text(iso: "2026-10"))
        XCTAssertNil(date.text(iso: "tomorrow"))
    }

    func testATimeRangeTakesAnEnDash() {
        XCTAssertEqual(DisplayDate.time("14:00-15:30"), "14:00\u{2013}15:30")
        XCTAssertEqual(DisplayDate.time("14:00"), "14:00")
    }

    // MARK: - Subtitles
    func testADateAndATimeRangeJoinAndTheRestFollowsAfterSeparators() {
        let text = subtitle([
            part(.date, "2026-10-16"),
            part(.timeRange, "14:00-15:30"),
            part(.recurrence, "daily"),
            part(.project, "Accounting")
        ])
        XCTAssertEqual(text, "Today 14:00\u{2013}15:30 \u{00B7} Every day \u{00B7} Accounting")
    }

    func testATimeWithoutADateStandsAlone() {
        XCTAssertEqual(subtitle([part(.time, "09:00"), part(.place, "Office")]), "09:00 \u{00B7} Office")
    }

    func testKeysBecomeWordsAndUnknownKeysAreLeftOut() {
        XCTAssertEqual(
            subtitle([part(.relationship, "client"), part(.status, "inProgress")]),
            "Client \u{00B7} In progress"
        )
        XCTAssertEqual(subtitle([part(.relationship, "somethingNew"), part(.status, "unheard")]), "")
        XCTAssertEqual(subtitle([part(.recurrence, "yearly")]), "")
    }

    func testEveryKnownKeyHasItsWords() {
        let recurrences = ["daily", "weekdays", "weekly", "monthly", "custom"]
        let relationships = [
            "client", "closeFriend", "parent", "girlfriend", "therapist", "neighbor", "colleague", "craftsman",
            "doctor", "company"
        ]
        let statuses = [
            "notDone", "done", "wontDo", "missed", "inProgress", "longTerm", "archived", "monitoring", "resolved"
        ]
        for key in recurrences { XCTAssertFalse(subtitle([part(.recurrence, key)]).isEmpty, key) }
        for key in relationships { XCTAssertFalse(subtitle([part(.relationship, key)]).isEmpty, key) }
        for key in statuses { XCTAssertFalse(subtitle([part(.status, key)]).isEmpty, key) }
    }

    func testCountsAndTheMovedAndMissedNotesAreComposed() {
        XCTAssertEqual(subtitle([part(.count, "6")]), "Projects: 6")
        XCTAssertEqual(subtitle([part(.count, "many")]), "")
        XCTAssertEqual(subtitle([part(.movedFrom, "2026-10-15")]), "moved from Yesterday")
        XCTAssertEqual(subtitle([part(.movedFrom, "soon")]), "")
        XCTAssertEqual(subtitle([part(.missedInEvent, "Dentist")]), "missed in Dentist")
    }

    func testPlainValuesAreShownAsTheyAre() {
        XCTAssertEqual(
            subtitle([
                part(.area, "Work"), part(.people, "Petr, Jana"), part(.phone, "777 123 456"), part(.sender, "Petr")
            ]),
            "Work \u{00B7} Petr, Jana \u{00B7} 777 123 456 \u{00B7} Petr"
        )
    }

    // MARK: - Profile initials
    func testInitialsAreThoseOfTheFirstTwoWordsOfTheAddress() {
        XCTAssertEqual(ProfileInitials.text(email: "david.tresnak@example.cz"), "DT")
        XCTAssertEqual(ProfileInitials.text(email: "anna_marie-novak@example.cz"), "AM")
        XCTAssertEqual(ProfileInitials.text(email: "petr@example.cz"), "PE")
        XCTAssertEqual(ProfileInitials.text(email: "x@example.cz"), "X")
        XCTAssertNil(ProfileInitials.text(email: nil))
        XCTAssertNil(ProfileInitials.text(email: "@example.cz"))
        XCTAssertNil(ProfileInitials.text(email: ""))
    }

    // MARK: - Colors and symbols
    func testStoredHexColorsAreReadAndAnythingElseIsNot() {
        XCTAssertNotNil(Color(hex: "#FF3B30"))
        XCTAssertNil(Color(hex: nil))
        XCTAssertNil(Color(hex: "FF3B30"))
        XCTAssertNil(Color(hex: "#FFF"))
        XCTAssertNil(Color(hex: "#GGGGGG"))
    }

    func testStoredIconNamesMapToSymbolsWithFallbacksByWhatTheRowIs() {
        XCTAssertEqual(OverviewSymbols.symbol(forIcon: "Checkmark-Circle"), "checkmark.circle")
        XCTAssertNil(OverviewSymbols.symbol(forIcon: "unheard-of"))
        XCTAssertNil(OverviewSymbols.symbol(forIcon: nil))
        XCTAssertEqual(OverviewSymbols.area(icon: "briefcase"), "briefcase")
        XCTAssertEqual(OverviewSymbols.area(icon: "unheard-of"), OverviewSymbols.areaFallback)
        XCTAssertEqual(OverviewSymbols.collection(icon: "calendar", ownerModuleId: "events"), "calendar")
        XCTAssertEqual(OverviewSymbols.collection(icon: nil, ownerModuleId: "movies"), "film")
        XCTAssertEqual(
            OverviewSymbols.collection(icon: nil, ownerModuleId: "unheard"),
            OverviewSymbols.collectionFallback
        )
        for type in SearchGroupType.allCases {
            XCTAssertFalse(OverviewSymbols.searchGroup(type).isEmpty)
        }
    }

    // MARK: - Failures
    func testEveryFailureHasItsOwnMessageAndTheUnexpectedOneIsTheFallback() {
        let failures: [FailureKind?] = [.unavailable, .invalidData, .unauthorized, .notFound, .rejected, nil]
        let messages = Set(failures.map { FailureKind.message(for: $0) })
        XCTAssertEqual(messages.count, 6)
        XCTAssertFalse(messages.contains { $0.hasPrefix("failure.") })
    }
}
