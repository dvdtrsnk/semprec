import SharedSDK
import XCTest

@testable import CoreKit

/// The calendar's nights of sleep and its task checkboxes inside events, across the Kotlin boundary.
@MainActor
final class SharedCalendarSleepMappingTests: XCTestCase {

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
                planBedMinutes: 1350,
                planWakeMinutes: 405,
                durationMinutes: 465,
                goalMinutes: 480,
                meetsGoal: false
            )
        )
    }

    func testAMovedNightMapsItsTimesItsLengthAndItsGoal() {
        let drag = SharedSDK.CalendarSleepDrag(
            night: "2026-10-15",
            bedMinutes: 1350,
            wakeMinutes: 405,
            committing: true,
            durationMinutes: 495,
            meetsGoal: KotlinBoolean(bool: true),
            changed: true
        )
        XCTAssertEqual(
            Model.state(CalendarKotlin.state(.content, sleepDrag: drag)).sleepDrag,
            CoreKit.CalendarSleepDrag(
                night: "2026-10-15",
                bedMinutes: 1350,
                wakeMinutes: 405,
                committing: true,
                durationMinutes: 495,
                meetsGoal: true,
                changed: true
            )
        )
        let withoutGoal = SharedSDK.CalendarSleepDrag(
            night: "n", bedMinutes: 0, wakeMinutes: 60, committing: false, durationMinutes: 60, meetsGoal: nil,
            changed: false
        )
        XCTAssertNil(Model.state(CalendarKotlin.state(.content, sleepDrag: withoutGoal)).sleepDrag?.meetsGoal)
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
