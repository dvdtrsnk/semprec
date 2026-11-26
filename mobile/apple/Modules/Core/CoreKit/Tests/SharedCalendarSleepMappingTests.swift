import SharedSDK
import XCTest

@testable import CoreKit

/// The sleep of a calendar day on its way from the Kotlin state.
@MainActor
final class SharedCalendarSleepMappingTests: XCTestCase {

    func testAMorningSleepKeepsAReminderThatFallsAfterMidnight() {
        let morning = SharedSDK.CalendarSleep(
            night: "2026-10-15",
            bedMinutes: 60,
            wakeMinutes: 540,
            alarm: false,
            changed: false,
            prepMinutes: KotlinInt(int: 30),
            fromMinutes: 60,
            toMinutes: 540
        )
        let day = SharedSDK.CalendarDayState(date: "2026-10-16", items: [], sleepEvening: nil, sleepMorning: morning)
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(.content, days: [day]))
        XCTAssertEqual(state.days.first?.sleepMorning?.prepMinutes, 30)
        XCTAssertEqual(state.days.first?.sleepMorning?.fromMinutes, 60)
        XCTAssertEqual(state.days.first?.sleepMorning?.toMinutes, 540)
    }
}
