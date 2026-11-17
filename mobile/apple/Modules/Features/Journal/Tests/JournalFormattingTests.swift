import CoreKit
import SwiftUI
import XCTest

@testable import JournalFeature

final class JournalFormattingTests: XCTestCase {

    // MARK: - Styled text
    func testRunsBecomeFormattingWithoutSyntax() {
        let runs = [
            JournalRun(text: "Plain "),
            JournalRun(text: "bold", bold: true),
            JournalRun(text: " "),
            JournalRun(text: "both", bold: true, italic: true),
            JournalRun(text: " "),
            JournalRun(text: "code", code: true)
        ]
        let styled = runs.styled
        XCTAssertEqual(String(styled.characters), "Plain bold both code")
        let intents = styled.runs.map { $0.inlinePresentationIntent }
        XCTAssertEqual(intents, [
            nil, .stronglyEmphasized, nil, [.stronglyEmphasized, .emphasized], nil, .code
        ])
    }

    func testOnlyWebAndMailLinksAreLinks() {
        let runs = [
            JournalRun(text: "web", link: "https://example.com/a"),
            JournalRun(text: "mail", link: "mailto:a@example.com"),
            JournalRun(text: "item", link: "semprec://items/3f2b8c1e-5a47-4d0b-9c61-7e2a1b9d4f10")
        ]
        let links = runs.styled.runs.map { $0.link?.absoluteString }
        XCTAssertEqual(links, ["https://example.com/a", "mailto:a@example.com", nil])
    }

    func testNoRunsAreEmptyText() {
        XCTAssertEqual(String([JournalRun]().styled.characters), "")
    }

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
        XCTAssertEqual(JournalDates.quarterSpan(start: "2026-10-01"), "October – December 2026")
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
        XCTAssertEqual(message("journal.placeholder.day"), "Jak se dnes máš?")
        XCTAssertEqual(message("journal.placeholder.week"), "Co tě tento týden čeká…")
        XCTAssertEqual(message("journal.week"), "Týden %lld")
        XCTAssertEqual(message("journal.subtitle.month"), "Týdny v měsíci")
    }

    // MARK: - Helpers
    private func czechBundle() throws -> Bundle {
        let path = try XCTUnwrap(Bundle.module.path(forResource: "cs", ofType: "lproj"))
        return try XCTUnwrap(Bundle(path: path))
    }
}
