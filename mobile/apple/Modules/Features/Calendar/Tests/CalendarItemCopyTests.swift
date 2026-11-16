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
        XCTAssertEqual(item().timeText, "14:00–15:30")
        XCTAssertEqual(item(end: 870, hasEnd: false).timeText, "14:00")
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
        XCTAssertTrue(CalendarEventTask(id: "t", title: "T", state: .doneElsewhere, note: nil).isDone)
        XCTAssertFalse(CalendarEventTask(id: "t", title: "T", state: .missed, note: nil).isDone)
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
        XCTAssertEqual(CalendarGeometry.y(minutes: 60), 56)
        XCTAssertEqual(CalendarGeometry.minutes(position: 56), 60)
        XCTAssertEqual(CalendarGeometry.minutes(position: -10), 0)
        XCTAssertEqual(CalendarGeometry.minutes(position: 100_000), 1440)
        XCTAssertEqual(CalendarGeometry.height, 56 * 24)
        XCTAssertEqual(CalendarGeometry.blockHeight(start: 600, end: 601), 22)
        XCTAssertEqual(CalendarGeometry.blockHeight(start: 600, end: 660), 56)
        XCTAssertEqual(CalendarGeometry.hourId(7), "hour-7")
    }
}
