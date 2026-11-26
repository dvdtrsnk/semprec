import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarSleepDragPartsTests: XCTestCase {

    // MARK: - Tests
    func testAMovedNightIsDrawnWithThePartsOfItsDragOnItsEveningAndTheMorningAfter() {
        let evening = sleep(from: 1_380, until: 1_440, prep: 1_350)
        let movedEvening = sleep(from: 1_320, until: 1_440)
        let movedMorning = sleep(from: 0, until: 345)
        let drag = CalendarSleepDrag(
            night: "2026-10-16", bedMinutes: 1_320, wakeMinutes: 345, committing: false,
            evening: movedEvening, morning: movedMorning, morningDay: "2026-10-17"
        )
        let onEvening = CalendarDayState(date: "2026-10-16", items: [], sleepEvening: evening, sleepMorning: nil)
        let onMorning = CalendarDayState(date: "2026-10-17", items: [], sleepEvening: nil, sleepMorning: nil)

        XCTAssertEqual(onEvening.sleepParts(dragging: drag), [.band(movedEvening, 1_320..<1_440, isEvening: true)])
        XCTAssertEqual(onMorning.sleepParts(dragging: drag), [.band(movedMorning, 0..<345, isEvening: false)])
    }

    func testWithoutADragOrOnAnotherDayTheSleepIsDrawnAsItIs() {
        let evening = sleep(from: 1_380, until: 1_440, prep: 1_350)
        let day = CalendarDayState(date: "2026-10-20", items: [], sleepEvening: evening, sleepMorning: nil)
        let drag = CalendarSleepDrag(
            night: "2026-10-16", bedMinutes: 1_320, wakeMinutes: 345, committing: false, morningDay: "2026-10-17"
        )

        XCTAssertEqual(day.sleepParts(dragging: nil), day.sleepParts)
        XCTAssertEqual(day.sleepParts(dragging: drag), day.sleepParts)
    }

    // MARK: - Helpers
    private func sleep(from start: Int, until end: Int, prep: Int? = nil) -> CalendarSleep {
        CalendarSleep(
            night: "2026-10-16", bedMinutes: 1_380, wakeMinutes: 405, alarm: true, changed: false, prepMinutes: prep,
            fromMinutes: start, toMinutes: end
        )
    }
}
