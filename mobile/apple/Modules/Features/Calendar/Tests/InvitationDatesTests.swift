import XCTest

@testable import CalendarFeature

final class InvitationDatesTests: XCTestCase {

    // MARK: - Properties
    private let czech = Locale(identifier: "cs_CZ")
    private let american = Locale(identifier: "en_US")

    // MARK: - Tests
    func testReadsInstantsWithAndWithoutFractionalSeconds() {
        XCTAssertEqual(InvitationDates.instant("2026-10-23T17:00:00Z"), Date(timeIntervalSince1970: 1_792_774_800))
        XCTAssertEqual(
            InvitationDates.instant("2026-10-23T17:00:00.250Z"),
            Date(timeIntervalSince1970: 1_792_774_800.25)
        )
        XCTAssertEqual(InvitationDates.instant("2026-10-23T19:00:00+02:00"), Date(timeIntervalSince1970: 1_792_774_800))
        XCTAssertNil(InvitationDates.instant("2026-10-23"))
        XCTAssertNil(InvitationDates.instant("tomorrow"))
    }

    func testATimedInvitationShowsItsDayAndTimesInItsZone() {
        XCTAssertEqual(
            when("2026-10-23T17:00:00.000Z", "2026-10-23T20:00:00.000Z", zone: "Europe/Prague", locale: czech),
            "pá 23. 10. · 19:00–22:00"
        )
        XCTAssertEqual(
            when("2026-10-23T17:00:00Z", "2026-10-23T20:00:00Z", zone: "Europe/Prague", locale: american),
            "Fri, 10/23 · 7:00 PM–10:00 PM"
        )
    }

    func testTheZoneDecidesTheDay() {
        XCTAssertEqual(
            when("2026-10-23T23:30:00Z", nil, zone: "Asia/Tokyo", locale: czech),
            "so 24. 10. · 8:30"
        )
    }

    func testAnInvitationOverSeveralDaysShowsBothDays() {
        XCTAssertEqual(
            when("2026-10-23T20:00:00Z", "2026-10-24T08:00:00Z", zone: "Europe/Prague", locale: czech),
            "pá 23. 10. · 22:00 – so 24. 10. 10:00"
        )
    }

    func testAnEndThatIsNotAfterTheStartIsLeftOut() {
        XCTAssertEqual(
            when("2026-10-23T17:00:00Z", "2026-10-23T17:00:00Z", zone: "Europe/Prague", locale: czech),
            "pá 23. 10. · 19:00"
        )
        XCTAssertEqual(
            when("2026-10-23T17:00:00Z", "later", zone: "Europe/Prague", locale: czech),
            "pá 23. 10. · 19:00"
        )
    }

    func testAnAllDayInvitationShowsItsDaysWithoutTheExclusiveEnd() {
        XCTAssertEqual(
            when("2026-10-27T23:00:00Z", "2026-10-28T23:00:00Z", zone: "Europe/Prague", allDay: true, locale: czech),
            "st 28. 10. · all day"
        )
        XCTAssertEqual(
            when("2026-10-27T23:00:00Z", "2026-10-30T23:00:00Z", zone: "Europe/Prague", allDay: true, locale: czech),
            "st 28. 10. – pá 30. 10. · all day"
        )
        XCTAssertEqual(
            when("2026-10-27T23:00:00Z", nil, zone: "Europe/Prague", allDay: true, locale: czech),
            "st 28. 10. · all day"
        )
    }

    func testAnUnknownZoneFallsBackToTheDevicesZone() {
        let start = "2026-10-23T17:00:00Z"
        XCTAssertEqual(
            when(start, nil, zone: "Mars/Olympus", locale: czech),
            when(start, nil, zone: TimeZone.current.identifier, locale: czech)
        )
        XCTAssertEqual(
            when(start, nil, zone: nil, locale: czech),
            when(start, nil, zone: "Mars/Olympus", locale: czech)
        )
    }

    func testNoReadableStartShowsNothing() {
        XCTAssertNil(when(nil, "2026-10-23T17:00:00Z", zone: "Europe/Prague", locale: czech))
        XCTAssertNil(when("soon", nil, zone: "Europe/Prague", locale: czech))
    }

    // MARK: - Helpers
    private func when(
        _ start: String?,
        _ end: String?,
        zone: String?,
        allDay: Bool = false,
        locale: Locale
    ) -> String? {
        InvitationDates.when(
            startsAt: start, endsAt: end, timeZone: zone, allDay: allDay, allDayText: "all day", locale: locale
        )
        .map { text in String(text.map { Self.breakingSpaces.contains($0) ? " " : $0 }) }
    }

    /// The non-breaking spaces the formatters put between the parts of a date and a time, read as spaces.
    private static let breakingSpaces: Set<Character> = ["\u{00A0}", "\u{202F}"]
}
