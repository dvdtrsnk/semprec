import XCTest

@testable import Semprec

/// The Calendar router presents its sheets, and the sleep sheets, over the Calendar tab's stack.
final class CalendarNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheRouterPresentsEverySheetOverTheCalendarStack() {
        let context = NavigationContext()
        let calendar = CalendarStackSpy()
        let overview = CalendarStackSpy()
        context.register(calendar, for: .calendar)
        context.register(overview, for: .overview)
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
        XCTAssertTrue(overview.sheets.isEmpty)
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
    func testOpeningAnEventOrATaskPresentsPodrobnostiOverTheCalendarStack() {
        let context = NavigationContext()
        let calendar = CalendarStackSpy()
        context.register(calendar, for: .calendar)
        let router = AppCalendarRouter(context: context)
        router.showDetails(itemId: "e1", kind: .event, day: "2026-10-16")
        router.showDetails(itemId: "t1", kind: .task, day: "2026-10-16")
        XCTAssertEqual(
            calendar.sheets,
            [.details(ItemDetailsTarget(kind: .event, id: "e1")), .details(ItemDetailsTarget(kind: .task, id: "t1"))]
        )
        XCTAssertTrue(calendar.pushed.isEmpty)
    }

    @MainActor
    func testKindsWithoutADetailsSheetOpenNothing() {
        let context = NavigationContext()
        let calendar = CalendarStackSpy()
        context.register(calendar, for: .calendar)
        let router = AppCalendarRouter(context: context)
        router.showDetails(itemId: "b1", kind: .birthday, day: "2026-10-16")
        router.showDetails(itemId: "h1", kind: .holiday, day: "2026-10-16")
        router.showDetails(itemId: "s1", kind: .sleep, day: "2026-10-16")
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
