import Combine
import CoreKit
import XCTest

@testable import Semprec

/// A tapped notification opens on the Calendar tab: a calendar change or an event's reminder the event, a task's
/// reminder the task, an invitation the invitations, also when the tap launched the app before the tab was shown.
final class NotificationNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testEveryTargetOpensOverTheCalendarStackAndSelectsTheCalendarTab() {
        let context = NavigationContext()
        let calendar = NotificationStackSpy()
        let overview = NotificationStackSpy()
        context.register(calendar, for: .calendar)
        context.register(overview, for: .overview)
        var selected: [AppTab] = []
        let subscription = context.tabRequests.sink { selected.append($0) }
        defer { subscription.cancel() }

        context.open(.event(id: "e1"))
        context.open(.task(id: "t1"))
        context.open(.invitations)

        XCTAssertEqual(
            calendar.sheets,
            [
                .details(ItemDetailsTarget(kind: .event, id: "e1", tab: .calendar)),
                .details(ItemDetailsTarget(kind: .task, id: "t1", tab: .calendar)),
                .invitations
            ]
        )
        XCTAssertEqual(selected, [.calendar, .calendar, .calendar])
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testATapBeforeTheCalendarIsShownOpensWhenItsStackRegistersOnce() {
        let context = NavigationContext()
        context.open(.invitations)
        context.open(.event(id: "e1"))

        let calendar = NotificationStackSpy()
        context.register(calendar, for: .calendar)
        context.register(calendar, for: .calendar)

        XCTAssertEqual(calendar.sheets, [.details(ItemDetailsTarget(kind: .event, id: "e1", tab: .calendar))])
    }

    @MainActor
    func testTheSceneOpensATappedNotificationThatWaitsAndOnlyOnce() {
        let shared = SharedDeviceNotifications(sessionStore: .memory)
        let notifications = AppNotifications(
            service: shared,
            alarms: shared,
            center: SystemNotificationCenter(),
            environment: .sandbox,
            deviceServices: shared.deviceServices
        )
        let composition = AppComposition(models: SignedInModels(), notifications: notifications)
        let calendar = NotificationStackSpy()
        composition.navigation.register(calendar, for: .calendar)

        notifications.didOpen(["event_id": "e1", "calendar_id": "c1"])
        composition.openTappedNotification()
        composition.openTappedNotification()

        XCTAssertEqual(calendar.sheets, [.details(ItemDetailsTarget(kind: .event, id: "e1", tab: .calendar))])
    }
}

// MARK: - Spies
@MainActor
private final class NotificationStackSpy: StackNavigating {

    // MARK: - Properties
    private(set) var sheets: [AppDestination] = []

    // MARK: - Protocol conformance
    var top: AppDestination? { nil }

    func push(_ destination: AppDestination) {}

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }

    func dismissPresented() {}
}
