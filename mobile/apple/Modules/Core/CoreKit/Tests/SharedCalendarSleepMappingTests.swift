import SharedSDK
import XCTest

@testable import CoreKit

/// The parts of a night of sleep that the calendar's day timeline draws: both Kotlin values and what they map to. Both
/// modules declare these type names, so each is qualified with its module.
final class SharedCalendarSleepMappingTests: XCTestCase {

    // MARK: - Tests
    func testStateMapsTheMorningBandOfANightWithoutAReminder() {
        let day = SharedSDK.CalendarDayState(
            date: "2026-10-16",
            items: [],
            sleepEvening: nil,
            sleepMorning: CalendarKotlin.morningSleep()
        )
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(.content, days: [day]))

        XCTAssertNil(state.days.first?.sleepEvening)
        XCTAssertEqual(
            state.days.first?.sleepMorning,
            CoreKit.CalendarSleep(
                night: "2026-10-15",
                bedMinutes: 1380,
                wakeMinutes: 405,
                alarm: true,
                changed: false,
                prepMinutes: nil,
                fromMinutes: 0,
                toMinutes: 405
            )
        )
    }

    func testStateMapsTheEveningBandWithItsReminder() {
        let day = SharedSDK.CalendarDayState(
            date: "2026-10-15",
            items: [],
            sleepEvening: CalendarKotlin.sleep(),
            sleepMorning: nil
        )
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(.content, days: [day]))

        XCTAssertEqual(state.days.first?.sleepEvening?.fromMinutes, 1380)
        XCTAssertEqual(state.days.first?.sleepEvening?.toMinutes, 1440)
        XCTAssertEqual(state.days.first?.sleepEvening?.prepMinutes, 1350)
        XCTAssertNil(state.days.first?.sleepMorning)
    }
}
