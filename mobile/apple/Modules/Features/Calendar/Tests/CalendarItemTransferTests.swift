import XCTest

@testable import CalendarFeature

final class CalendarItemTransferTests: XCTestCase {

    // MARK: - Helpers
    private func transfer(
        isTask: Bool = false,
        title: String = "Planning",
        date: String = "2026-12-08",
        endDate: String? = nil,
        timeFrom: Int? = 11 * 60 + 30,
        timeTo: Int? = 12 * 60 + 30,
        place: String? = nil,
        done: Bool = false
    ) -> CalendarItemTransfer {
        CalendarItemTransfer(
            id: "item-1",
            isTask: isTask,
            title: title,
            date: date,
            endDate: endDate,
            timeFrom: timeFrom,
            timeTo: timeTo,
            place: place,
            done: done,
            timezone: "Europe/Prague"
        )
    }

    private func lines(_ transfer: CalendarItemTransfer) -> [String] {
        transfer.iCalendar.components(separatedBy: "\r\n")
    }

    // MARK: - iCalendar
    func testATimedEventIsWrittenInUTCWithCRLFLineEnds() {
        let ics = transfer(place: "Room 4").iCalendar
        XCTAssertTrue(ics.hasPrefix("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
        XCTAssertTrue(ics.hasSuffix("END:VEVENT\r\nEND:VCALENDAR\r\n"))
        let all = lines(transfer(place: "Room 4"))
        // 11:30 in Prague in December is 10:30 UTC.
        XCTAssertTrue(all.contains("DTSTART:20261208T103000Z"))
        XCTAssertTrue(all.contains("DTEND:20261208T113000Z"))
        XCTAssertTrue(all.contains("UID:item-1@semprec"))
        XCTAssertTrue(all.contains("LOCATION:Room 4"))
        XCTAssertFalse(all.contains { $0.hasPrefix("CATEGORIES:") })
    }

    func testAnEventIntoSummerTimeUsesThatDaysOffset() {
        let all = lines(transfer(date: "2026-07-01", timeFrom: 9 * 60, timeTo: 10 * 60))
        XCTAssertTrue(all.contains("DTSTART:20260701T070000Z"))
        XCTAssertTrue(all.contains("DTEND:20260701T080000Z"))
    }

    func testAnAllDayItemEndsTheDayAfterItsLast() {
        let single = lines(transfer(timeFrom: nil, timeTo: nil))
        XCTAssertTrue(single.contains("DTSTART;VALUE=DATE:20261208"))
        XCTAssertTrue(single.contains("DTEND;VALUE=DATE:20261209"))
        let span = lines(transfer(endDate: "2026-12-31", timeFrom: nil, timeTo: nil))
        XCTAssertTrue(span.contains("DTEND;VALUE=DATE:20270101"))
    }

    func testATaskWithoutAnEndLastsAQuarterOfAnHourAndSaysItIsATask() {
        let all = lines(transfer(isTask: true, timeFrom: 14 * 60, timeTo: nil))
        XCTAssertTrue(all.contains("DTSTART:20261208T130000Z"))
        XCTAssertTrue(all.contains("DTEND:20261208T131500Z"))
        XCTAssertTrue(all.contains("TRANSP:TRANSPARENT"))
        XCTAssertTrue(all.contains { $0.hasPrefix("CATEGORIES:") })
        XCTAssertTrue(all.contains { $0.hasPrefix("DESCRIPTION:") })
    }

    func testTextValuesAreEscaped() {
        let all = lines(transfer(title: "A, b; c\\d\ne"))
        XCTAssertTrue(all.contains(#"SUMMARY:A\, b\; c\\d\ne"#))
    }

    func testLongLinesAreFoldedAtSeventyFiveOctetsNeverInsideACharacter() {
        let title = String(repeating: "ř", count: 60)
        let folded = lines(transfer(title: title))
        let summary = folded.drop { !$0.hasPrefix("SUMMARY:") }
        XCTAssertTrue(folded.allSatisfy { $0.utf8.count <= 75 })
        let joined = summary.prefix { $0.hasPrefix("SUMMARY:") || $0.hasPrefix(" ") }
            .enumerated().map { $0.offset == 0 ? $0.element : String($0.element.dropFirst()) }.joined()
        XCTAssertEqual(joined, "SUMMARY:" + title)
    }

    // MARK: - Plain text and file name
    func testTheTextHasTheTitleAndThePlace() {
        let text = transfer(place: "Room 4").text.components(separatedBy: "\n")
        XCTAssertEqual(text.first, "Planning")
        XCTAssertEqual(text.last, "Room 4")
        XCTAssertEqual(text.count, 3)
    }

    func testTheFileNameLeavesOutWhatAFileSystemRefuses() {
        XCTAssertEqual(transfer(title: "a/b:c?").fileTitle, "a b c")
        XCTAssertFalse(transfer(title: " / ").fileTitle.isEmpty)
    }
}
