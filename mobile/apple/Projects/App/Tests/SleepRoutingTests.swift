import CoreKit
import XCTest

@testable import Alldots

/// What the Sleep feature's route does in the app: the router presents the wake settings as a sheet over the stack of
/// the tab the person is on.
final class SleepRoutingTests: XCTestCase {

    // MARK: - Router
    @MainActor
    func testTheWakeSettingsArePresentedOverTheStackOfTheCurrentTabOnly() {
        let context = NavigationContext()
        let overview = SleepStackSpy()
        let calendar = SleepStackSpy()
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)
        var tab = AppTab.calendar
        let router = AppSleepRouter(context: context, tab: { tab })

        router.showWakeSettings()
        XCTAssertEqual(calendar.sheets, [.sleepWakeSettings])
        XCTAssertTrue(overview.sheets.isEmpty)

        tab = .overview
        router.showWakeSettings()
        XCTAssertEqual(overview.sheets, [.sleepWakeSettings])
        XCTAssertTrue(calendar.pushed.isEmpty && overview.pushed.isEmpty, "The wake settings are never pushed")
    }

    @MainActor
    func testTheWakeSettingsRouteBeforeTheStackRegisteredIsDropped() {
        let router = AppSleepRouter(context: NavigationContext(), tab: { .overview })

        router.showWakeSettings()
    }

    @MainActor
    func testTheCompositionHandsTheSleepSheetsARouterOnItsCurrentTab() {
        let composition = AppComposition(models: SignedInModels())
        let calendar = SleepStackSpy()
        composition.navigation.register(calendar, for: .calendar)
        composition.currentTab = .calendar

        composition.sleepRouter.showWakeSettings()

        XCTAssertEqual(calendar.sheets, [.sleepWakeSettings])
    }

    @MainActor
    func testTwoCompositionsOverTheSameDeviceServicesShareThemAndOtherServicesAreApart() {
        let services = SharedDeviceNotifications(sessionStore: .memory).deviceServices
        let first = AppComposition(deviceServices: services, notifications: nil)
        let second = AppComposition(deviceServices: services, notifications: nil)
        let apart = AppComposition(
            deviceServices: SharedDeviceNotifications(sessionStore: .memory).deviceServices,
            notifications: nil
        )
        let firstSettings = first.models.makeWakeSettings()
        let secondSettings = second.models.makeWakeSettings()
        let apartSettings = apart.models.makeWakeSettings()

        firstSettings.send(.setRequiresCode(true))

        XCTAssertTrue(firstSettings.state.requiresCode)
        XCTAssertTrue(secondSettings.state.requiresCode, "The windows share the one wake storage of the device")
        XCTAssertFalse(apartSettings.state.requiresCode, "A composition holds no services but the ones it was given")
    }

    func testTheWakeSettingsAreASheetThatCoversTheSempBubble() {
        XCTAssertTrue(AppDestination.sleepWakeSettings.presentsAsSheet)
    }
}

// MARK: - Spies
@MainActor
private final class SleepStackSpy {

    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension SleepStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }

    func dismissPresented() {}
}
