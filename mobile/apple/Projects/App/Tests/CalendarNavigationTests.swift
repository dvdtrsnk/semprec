import XCTest

@testable import Semprec

/// The Calendar router presents its sheets, and the sleep sheets, over the Calendar tab's stack.
final class CalendarNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheRouterPresentsEverySheetOverTheCalendarStack() {
        let context = NavigationContext()
        let calendar = CalendarStackSpy()
        let home = CalendarStackSpy()
        context.register(calendar, for: .calendar)
        context.register(home, for: .home)
        let router = AppCalendarRouter(context: context)
        router.showCalendars()
        router.showInvitations()
        router.showNewItem(day: "2026-10-17")
        router.showSleepNight(night: "2026-10-16")
        router.showSleepPlan()
        XCTAssertEqual(
            calendar.sheets,
            [.calendars, .invitations, .newItem(
                day: "2026-10-17"
            ), .sleepNight(night: "2026-10-16"), .sleepPlan(night: nil)]
        )
        XCTAssertTrue(calendar.pushed.isEmpty)
        XCTAssertTrue(home.sheets.isEmpty)
    }

    @MainActor
    func testASheetRequestedBeforeTheStackIsRegisteredIsDropped() {
        let context = NavigationContext()
        let router = AppCalendarRouter(context: context)
        router.showCalendars()
        let calendar = CalendarStackSpy()
        context.register(calendar, for: .calendar)
        XCTAssertTrue(calendar.sheets.isEmpty)
    }

    @MainActor
    func testOpeningDetailsIsAStubUntilTheDetailsSliceIsMerged() {
        let context = NavigationContext()
        let calendar = CalendarStackSpy()
        context.register(calendar, for: .calendar)
        AppCalendarRouter(context: context).showDetails(itemId: "e1", kind: .event, day: "2026-10-16")
        XCTAssertTrue(calendar.pushed.isEmpty)
        XCTAssertTrue(calendar.sheets.isEmpty)
    }
}

// MARK: - Spies
@MainActor
private final class CalendarStackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension CalendarStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }
}
