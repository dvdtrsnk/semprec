import CoreKit
import XCTest

@testable import CollectionsFeature

final class FieldFormatTests: XCTestCase {

    // MARK: - Properties
    private let locale = Locale(identifier: "en_US")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague") ?? .gmt
        return calendar
    }

    /// 16 October 2026 at 10:00 in Prague, a Friday.
    private var format: FieldFormat {
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 10)) ?? Date()
        return FieldFormat(calendar: calendar, locale: locale, now: now)
    }

    /// The text with the narrow and no-break spaces of the locale data turned into plain spaces.
    private func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    // MARK: - Dates
    func testADateTimeStartsWithItsDay() {
        let date = format.date(fromISO: "2026-10-16T14:00:00Z")
        XCTAssertEqual(calendar.dateComponents([.year, .month, .day], from: date ?? Date()).day, 16)
        XCTAssertNil(format.date(fromISO: "soon"))
        XCTAssertNil(format.date(fromISO: "2026-10"))
    }

    func testAnIsoDayRoundTripsThroughADate() {
        let date = format.date(fromISO: "2026-03-04") ?? Date()
        XCTAssertEqual(format.iso(from: date), "2026-03-04")
    }

    func testTodayTomorrowAndYesterdayAreNamedAndOtherDaysShowTheWeekday() {
        XCTAssertEqual(format.day("2026-10-16"), "Today")
        XCTAssertEqual(format.day("2026-10-17"), "Tomorrow")
        XCTAssertEqual(format.day("2026-10-15"), "Yesterday")
        XCTAssertEqual(format.day("2026-10-22"), "Thu, 10/22")
        XCTAssertEqual(format.day("2027-01-31"), "Sun, 1/31/2027")
        XCTAssertEqual(format.day("soon"), "soon")
    }

    func testTheTodayFlagFollowsTheClock() {
        XCTAssertTrue(format.isToday("2026-10-16"))
        XCTAssertFalse(format.isToday("2026-10-17"))
        XCTAssertFalse(format.isToday("later"))
    }

    func testAFullDayAMonthAndATimeAreWordedByTheLocale() {
        XCTAssertEqual(format.fullDay("2026-10-16"), "10/16/2026")
        XCTAssertEqual(format.fullDay("later"), "later")
        XCTAssertEqual(format.month("2026-10"), "October 2026")
        XCTAssertEqual(format.month("x"), "x")
        XCTAssertEqual(plain(format.time("14:00")), "2:00 PM")
        XCTAssertEqual(format.time("late"), "late")
    }

    func testCzechWordsAndFormatsComeFromTheCzechLocale() {
        let now = format.date(fromISO: "2026-10-16") ?? Date()
        let czech = FieldFormat(calendar: calendar, locale: Locale(identifier: "cs_CZ"), now: now)
        XCTAssertEqual(czech.month("2026-10"), "říjen 2026")
        XCTAssertEqual(plain(czech.fullDay("2026-10-16")), "16. 10. 2026")
    }

    // MARK: - Content
    func testEachContentHasItsShortText() {
        let option = FieldOption(key: "a", label: "A", color: nil)
        let target = FieldTarget(id: "t", databaseKey: nil, title: "Work", color: nil)
        XCTAssertNil(format.text(for: .empty))
        XCTAssertEqual(format.text(for: .text("x")), "x")
        XCTAssertEqual(format.text(for: .link("https://a.cz")), "https://a.cz")
        XCTAssertEqual(format.text(for: .number(1_500.5)), "1,500.5")
        XCTAssertNil(format.text(for: .flag(false)))
        XCTAssertNotNil(format.text(for: .flag(true)))
        XCTAssertEqual(format.text(for: .day("2026-10-16")), "Today")
        XCTAssertEqual(plain(format.text(for: .clock("09:30")) ?? ""), "9:30 AM")
        XCTAssertEqual(format.text(for: .choices([option, FieldOption(key: "b", label: "B", color: nil)])), "A, B")
        XCTAssertEqual(format.text(for: .targets([target, target])), "Work, Work")
        let blob = FieldContent.blob(blobId: "b", filename: "a.pdf", mimeType: "application/pdf", byteSize: 1)
        XCTAssertEqual(format.text(for: blob), "a.pdf")
    }

    func testASubtitleJoinsWhatThereIsAndLeavesOutWhatIsEmpty() {
        XCTAssertEqual(format.subtitle([.text("Novák Web"), .empty, .day("2026-10-17")]), "Novák Web · Tomorrow")
        XCTAssertEqual(format.subtitle([]), "")
        XCTAssertEqual(format.subtitle([.empty, .flag(false)]), "")
    }

    func testAFileSizeIsAHumanSize() {
        XCTAssertEqual(format.fileSize(2_048), "2 KB")
    }
}
