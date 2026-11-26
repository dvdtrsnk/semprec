import CoreKit
import SwiftUI
import XCTest

@testable import CalendarFeature

@MainActor
final class CalendarItemCopyTests: XCTestCase {

    // MARK: - Helpers
    private func item(
        kind: CalendarItemKind = .task,
        start: Int? = 840,
        end: Int? = 930,
        hasEnd: Bool = true,
        done: Bool = false,
        missed: Bool = false,
        editable: Bool = true,
        trace: CalendarTraceOutcome? = nil,
        traceNote: String? = nil
    ) -> CalendarItem {
        CalendarItem(
            id: "t1", kind: kind, title: "Invoice", color: "#FF9500", date: "2026-10-16", allDay: start == nil,
            startMinutes: start, endMinutes: end, hasEnd: hasEnd, done: done, missed: missed, editable: editable,
            trace: trace, traceNote: traceNote
        )
    }

    // MARK: - Style
    func testTheTintIsTheCalendarColourAndFallsBackToTheAccent() {
        XCTAssertNotNil(Color(hex: "#FF9500"))
        XCTAssertNil(Color(hex: "orange"))
    }

    func testOnlyAnEditableTaskCanBeTicked() {
        XCTAssertTrue(item().canToggle)
        XCTAssertFalse(item(editable: false).canToggle)
        XCTAssertFalse(item(kind: .event).canToggle)
    }

    func testAGhostIsATraceOrAMissedTask() {
        XCTAssertTrue(item(kind: .trace).isGhost)
        XCTAssertTrue(item(missed: true).isGhost)
        XCTAssertFalse(item().isGhost)
    }

    func testTheIdentityIncludesTheDay() {
        XCTAssertEqual(item().identity, "t1@2026-10-16")
    }

    // MARK: - Copy
    func testTheTimeTextShowsTheRangeOrJustTheStart() {
        XCTAssertEqual(item().timeText, CalendarDates.range(from: 840, to: 930))
        XCTAssertEqual(item(end: 870, hasEnd: false).timeText, CalendarDates.clock(minutes: 840))
        XCTAssertNil(item(start: nil, end: nil).timeText)
    }

    func testTheToggleLabelFollowsTheState() {
        XCTAssertTrue(item().toggleLabel.contains("Invoice"))
        XCTAssertNotEqual(item().toggleLabel, item(done: true).toggleLabel)
    }

    func testATraceTellsHowTheChainEnded() {
        XCTAssertNotNil(item(kind: .trace, trace: .carried).traceDescription)
        XCTAssertNotNil(item(kind: .trace, trace: .missed).traceDescription)
        XCTAssertTrue(
            item(kind: .trace, trace: .movedToEvent, traceNote: "Review").traceDescription?.contains("Review") == true
        )
        XCTAssertNotEqual(
            item(kind: .trace, trace: .done, traceNote: "2026-10-17").traceDescription,
            item(kind: .trace, trace: .missed).traceDescription
        )
        XCTAssertNil(item().traceDescription)
    }

    func testATaskInAnEventDescribesItsState() {
        func note(_ state: CalendarTaskInEvent, _ text: String? = nil) -> String? {
            CalendarEventTask(id: "t", title: "T", state: state, note: text).stateNote
        }
        XCTAssertNil(note(.open))
        XCTAssertNil(note(.done))
        XCTAssertNotNil(note(.missed))
        XCTAssertTrue(note(.moved, "Review")?.contains("Review") == true)
        XCTAssertTrue(note(.doneElsewhere, "Review")?.contains("Review") == true)
        XCTAssertNotEqual(note(.doneElsewhere, "2026-10-17"), note(.doneElsewhere, "Review"))
        // Done elsewhere is not done in this event, and says so as a missed task does.
        XCTAssertTrue(CalendarEventTask(id: "t", title: "T", state: .done, note: nil).isDone)
        XCTAssertFalse(CalendarEventTask(id: "t", title: "T", state: .doneElsewhere, note: nil).isDone)
        XCTAssertFalse(CalendarEventTask(id: "t", title: "T", state: .missed, note: nil).isDone)
        XCTAssertTrue(CalendarEventTask(id: "t", title: "T", state: .doneElsewhere, note: nil).isNotDoneHere)
        XCTAssertTrue(CalendarEventTask(id: "t", title: "T", state: .missed, note: nil).isNotDoneHere)
        XCTAssertFalse(CalendarEventTask(id: "t", title: "T", state: .open, note: nil).isNotDoneHere)
    }

    func testTheCarriedFromTextNamesTheDay() {
        let moved = CalendarItem(
            id: "t", kind: .task, title: "T", color: "#007AFF", date: "2026-10-16", allDay: true,
            carriedFrom: "2026-10-14"
        )
        XCTAssertNotNil(moved.carriedDescription)
        XCTAssertNil(item().carriedDescription)
    }

    // MARK: - Geometry
    func testMinutesAndPointsConvertBothWays() {
        let geometry = CalendarGeometry()
        XCTAssertEqual(geometry.y(minutes: 60), 56)
        XCTAssertEqual(geometry.minutes(position: 56), 60)
        XCTAssertEqual(geometry.minutes(position: -10), 0)
        XCTAssertEqual(geometry.minutes(position: 100_000), 1440)
        XCTAssertEqual(geometry.height, 56 * 24)
        XCTAssertEqual(geometry.blockHeight(start: 600, end: 601), 22)
        XCTAssertEqual(geometry.blockHeight(start: 600, end: 660), 56)
        XCTAssertEqual(CalendarGeometry.hourId(7, day: "2026-11-18"), "2026-11-18-hour-7")
    }

    func testAPinchedHourHeightScalesTheDayWithinItsRange() {
        let tall = CalendarGeometry(hourHeight: 112)
        XCTAssertEqual(tall.y(minutes: 90), 168)
        XCTAssertEqual(tall.minutes(position: 168), 90)
        XCTAssertEqual(tall.height, 112 * 24)
        XCTAssertEqual(CalendarGeometry(hourHeight: 1).hourHeight, CalendarGeometry.minimumHourHeight)
        XCTAssertEqual(CalendarGeometry(hourHeight: 10_000).hourHeight, CalendarGeometry.maximumHourHeight)
    }
}
