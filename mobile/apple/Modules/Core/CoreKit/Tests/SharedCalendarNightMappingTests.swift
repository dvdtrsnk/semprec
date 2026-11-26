import SharedSDK
import XCTest

@testable import CoreKit

/// The calendar's nights of sleep and its task checkboxes inside events, across the Kotlin boundary.
@MainActor
final class SharedCalendarNightMappingTests: XCTestCase {

    private typealias Model = SharedCalendarScreenModel

    func testANightMapsItsTimesThePlanAndTheGoal() {
        let day = SharedSDK.CalendarDayState(
            date: "2026-10-16",
            items: [],
            sleepEvening: CalendarKotlin.sleep(),
            sleepMorning: nil
        )
        let mapped = Model.state(CalendarKotlin.state(.content, days: [day])).days.first
        XCTAssertEqual(
            mapped?.sleepEvening,
            CoreKit.CalendarSleep(
                night: "2026-10-15",
                bedMinutes: 1380,
                wakeMinutes: 405,
                alarm: true,
                changed: true,
                prepMinutes: 1350,
                fromMinutes: 1380,
                toMinutes: 1440,
                planBedMinutes: 1350,
                planWakeMinutes: 405,
                durationMinutes: 465,
                goalMinutes: 480,
                meetsGoal: false
            )
        )
    }

    func testAMovedNightMapsItsTimesAndItsPartsOnBothDays() {
        let drag = SharedSDK.CalendarSleepDrag(
            night: "2026-10-15",
            bedMinutes: 1380,
            wakeMinutes: 405,
            committing: true,
            evening: CalendarKotlin.sleep(),
            morning: CalendarKotlin.morningSleep(),
            morningDay: "2026-10-16"
        )
        let mapped = Model.state(CalendarKotlin.state(.content, sleepDrag: drag)).sleepDrag
        XCTAssertEqual(mapped?.night, "2026-10-15")
        XCTAssertEqual(mapped?.bedMinutes, 1380)
        XCTAssertEqual(mapped?.wakeMinutes, 405)
        XCTAssertEqual(mapped?.committing, true)
        XCTAssertEqual(mapped?.morningDay, "2026-10-16")
        XCTAssertEqual(mapped?.evening?.meetsGoal, false)
        XCTAssertEqual(mapped?.evening?.fromMinutes, 1380)
        XCTAssertEqual(mapped?.morning?.toMinutes, 405)
        let withoutParts = SharedSDK.CalendarSleepDrag(
            night: "n", bedMinutes: 0, wakeMinutes: 60, committing: false, evening: nil, morning: nil, morningDay: "d"
        )
        let empty = Model.state(CalendarKotlin.state(.content, sleepDrag: withoutParts)).sleepDrag
        XCTAssertNil(empty?.evening)
        XCTAssertNil(empty?.morning)
    }

    func testTheCheckboxOfATaskInAnEventAndTheMovesOfANightMapToKotlin() throws {
        let inEvent = try XCTUnwrap(
            Model.action(.gesture(.toggleDone(itemId: "c", inEventId: "e")))
                as? SharedSDK.CalendarActionGestureToggleDone
        )
        XCTAssertEqual(inEvent.inEventId, "e")
        let night = try XCTUnwrap(
            Model.action(.gesture(.sleepDrag(night: "2026-10-15", edge: .end, deltaMinutes: -30)))
                as? SharedSDK.CalendarActionGestureSleepDrag
        )
        XCTAssertEqual([night.night], ["2026-10-15"])
        XCTAssertEqual(night.edge, .end)
        XCTAssertEqual(night.deltaMinutes, -30)
        XCTAssertNil(
            (Model.action(.gesture(.sleepDrag(night: "n", edge: nil, deltaMinutes: 15)))
                as? SharedSDK.CalendarActionGestureSleepDrag)?.edge
        )
        XCTAssertEqual(
            (Model.action(.gesture(.endSleepDrag(commit: true)))
                as? SharedSDK.CalendarActionGestureEndSleepDrag)?.commit,
            true
        )
    }
}
