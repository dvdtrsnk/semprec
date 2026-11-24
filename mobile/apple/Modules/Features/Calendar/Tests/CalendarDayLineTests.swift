import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarDayLineTests: XCTestCase {

    // MARK: - Hours
    func testAnItemLastsItsHoursAndAtLeastOne() {
        XCTAssertEqual(CalendarDayLine.hours(item(start: 9 * 60, end: 12 * 60)), 3)
        XCTAssertEqual(CalendarDayLine.hours(item(start: 9 * 60, end: 9 * 60 + 90)), 1.5)
        XCTAssertEqual(CalendarDayLine.hours(item(start: 9 * 60, end: 9 * 60 + 20)), 1, "Shorter than an hour")
        XCTAssertEqual(CalendarDayLine.hours(item(allDay: true)), 1, "All day")
        XCTAssertEqual(CalendarDayLine.hours(item(start: 9 * 60, end: nil)), 1, "Without an end")
        XCTAssertEqual(CalendarDayLine.hours(item(start: nil, end: nil)), 1, "Without a time")
        XCTAssertEqual(CalendarDayLine.hours(item(start: 12 * 60, end: 9 * 60)), 1, "An end before the start")
    }

    // MARK: - Widths
    func testEachHourTakesItsPointsAndTheItemsKeepTheirShares() {
        XCTAssertEqual(CalendarDayLine.widths(hours: [1], cellWidth: 50), [6])
        XCTAssertEqual(CalendarDayLine.widths(hours: [3, 1], cellWidth: 50), [18, 6])
    }

    func testAFullDayIsCutDownToTheCellAndKeepsTheShares() {
        // 20 hours would be 120 points; the cell has 50 - 2 × 4 = 42.
        XCTAssertEqual(CalendarDayLine.widths(hours: [15, 5], cellWidth: 50), [31.5, 10.5])
    }

    func testNoRoomOrNoHoursDrawNothing() {
        XCTAssertEqual(CalendarDayLine.widths(hours: [2], cellWidth: 6), [0])
        XCTAssertEqual(CalendarDayLine.widths(hours: [], cellWidth: 50), [])
    }

    // MARK: - Helpers
    private func item(start: Int? = nil, end: Int? = nil, allDay: Bool = false) -> CalendarItem {
        CalendarItem(
            id: "i", kind: .event, title: "Item", color: "#007AFF", date: "2026-11-24",
            allDay: allDay, startMinutes: start, endMinutes: end, hasEnd: end != nil
        )
    }
}
