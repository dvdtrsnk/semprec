import NavigatorUI
import XCTest

@testable import Semprec

final class NavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testHomeRouterPushesTheDetailOntoTheHomeStack() {
        let context = NavigationContext()
        let home = StackSpy()
        let settings = StackSpy()
        context.register(home, for: .home)
        context.register(settings, for: .settings)
        AppHomeRouter(context: context).showDetail(itemId: "item-2")
        XCTAssertEqual(home.pushed, [.detail(itemId: "item-2")])
        XCTAssertTrue(home.sheets.isEmpty)
        XCTAssertTrue(settings.pushed.isEmpty)
    }

    @MainActor
    func testSettingsRouterPresentsAboutAsASheetOverTheSettingsStack() {
        let context = NavigationContext()
        let home = StackSpy()
        let settings = StackSpy()
        context.register(home, for: .home)
        context.register(settings, for: .settings)
        AppSettingsRouter(context: context).showAbout()
        XCTAssertEqual(settings.sheets, [.about])
        XCTAssertTrue(settings.pushed.isEmpty)
        XCTAssertTrue(home.sheets.isEmpty)
    }

    @MainActor
    func testARouteBeforeRegistrationIsDroppedAndALaterStackReplacesTheEarlierOne() {
        let context = NavigationContext()
        let router = AppHomeRouter(context: context)
        router.showDetail(itemId: "item-1")
        let first = StackSpy()
        context.register(first, for: .home)
        XCTAssertTrue(first.pushed.isEmpty)
        let second = StackSpy()
        context.register(second, for: .home)
        router.showDetail(itemId: "item-3")
        XCTAssertTrue(first.pushed.isEmpty)
        XCTAssertEqual(second.pushed, [.detail(itemId: "item-3")])
    }

    @MainActor
    func testScenesDoNotShareNavigation() {
        let first = NavigationContext()
        let second = NavigationContext()
        let firstStack = StackSpy()
        let secondStack = StackSpy()
        first.register(firstStack, for: .home)
        second.register(secondStack, for: .home)
        AppHomeRouter(context: first).showDetail(itemId: "item-1")
        XCTAssertEqual(firstStack.pushed, [.detail(itemId: "item-1")])
        XCTAssertTrue(secondStack.pushed.isEmpty)
    }

    /// A second tap on a row that arrives with the first asks for the detail already on top.
    @MainActor
    func testTheDetailOfTheItemOnTopIsNotPushedAgainAndTheDetailOfAnotherItemStacks() {
        let context = NavigationContext()
        let home = StackSpy()
        context.register(home, for: .home)
        let router = AppHomeRouter(context: context)
        router.showDetail(itemId: "item-3")
        router.showDetail(itemId: "item-3")
        XCTAssertEqual(home.pushed, [.detail(itemId: "item-3")])
        router.showDetail(itemId: "item-4")
        router.showDetail(itemId: "item-3")
        XCTAssertEqual(home.pushed, [.detail(itemId: "item-3"), .detail(itemId: "item-4"), .detail(itemId: "item-3")])
    }

    @MainActor
    func testAStackThatCannotTellItsTopTakesEveryPush() {
        let context = NavigationContext()
        let home = StackSpy()
        home.knowsTop = false
        context.register(home, for: .home)
        AppHomeRouter(context: context).showDetail(itemId: "item-3")
        AppHomeRouter(context: context).showDetail(itemId: "item-3")
        XCTAssertEqual(home.pushed, [.detail(itemId: "item-3"), .detail(itemId: "item-3")])
    }

    // MARK: - NavigatorUI stack
    /// Back, a back swipe and a pop remove entries from the end of the path without the adapter knowing.
    @MainActor
    func testTheAdapterKnowsTheTopThroughItsPushesAndThePopsOfTheStack() {
        let navigator = Navigator(configuration: .init())
        let stack = NavigatorStackAdapter(navigator)
        XCTAssertNil(stack.top)
        stack.push(.detail(itemId: "item-1"))
        stack.push(.detail(itemId: "item-2"))
        XCTAssertEqual(navigator.count, 2)
        XCTAssertEqual(stack.top, .detail(itemId: "item-2"))
        navigator.pop()
        XCTAssertEqual(stack.top, .detail(itemId: "item-1"))
        stack.push(.detail(itemId: "item-3"))
        XCTAssertEqual(navigator.count, 2)
        XCTAssertEqual(stack.top, .detail(itemId: "item-3"))
        navigator.popAll()
        XCTAssertNil(stack.top)
        stack.presentSheet(.about)
        XCTAssertNil(stack.top, "A sheet is no entry of the stack")
    }

    @MainActor
    func testAnEntryTheAdapterDidNotPushHidesTheTopUntilItIsPopped() {
        let navigator = Navigator(configuration: .init())
        let stack = NavigatorStackAdapter(navigator)
        stack.push(.detail(itemId: "item-1"))
        navigator.push(AppDestination.detail(itemId: "item-2"))
        XCTAssertNil(stack.top)
        stack.push(.detail(itemId: "item-3"))
        XCTAssertEqual(navigator.count, 3)
        XCTAssertEqual(stack.top, .detail(itemId: "item-3"))
        navigator.pop()
        XCTAssertNil(stack.top)
        navigator.pop()
        XCTAssertEqual(stack.top, .detail(itemId: "item-1"))
    }

    @MainActor
    func testOnARealStackTheDetailOfTheItemOnTopIsPushedOnceAlsoAfterABackSwipe() {
        let context = NavigationContext()
        let navigator = Navigator(configuration: .init())
        context.register(navigator, for: .home)
        let router = AppHomeRouter(context: context)
        router.showDetail(itemId: "item-3")
        router.showDetail(itemId: "item-3")
        XCTAssertEqual(navigator.count, 1)
        router.showDetail(itemId: "item-4")
        XCTAssertEqual(navigator.count, 2)
        navigator.pop()
        router.showDetail(itemId: "item-3")
        XCTAssertEqual(navigator.count, 1, "item-3's detail is on top again after the back swipe")
        router.showDetail(itemId: "item-4")
        XCTAssertEqual(navigator.count, 2)
    }

    /// The root of a stack registers its stack again each time it appears.
    @MainActor
    func testRegisteringTheSameNavigatorAgainKeepsItsAdapterAndAnotherNavigatorReplacesIt() throws {
        let context = NavigationContext()
        let navigator = Navigator(configuration: .init())
        context.register(navigator, for: .home)
        let registered = try XCTUnwrap(context.stack(for: .home))
        AppHomeRouter(context: context).showDetail(itemId: "item-3")
        context.register(navigator, for: .home)
        XCTAssertTrue(context.stack(for: .home) === registered)
        AppHomeRouter(context: context).showDetail(itemId: "item-3")
        XCTAssertEqual(navigator.count, 1)
        let other = Navigator(configuration: .init())
        context.register(other, for: .home)
        XCTAssertFalse(context.stack(for: .home) === registered)
        AppHomeRouter(context: context).showDetail(itemId: "item-3")
        XCTAssertEqual(other.count, 1)
        XCTAssertEqual(navigator.count, 1)
    }
}

// MARK: - Spies
@MainActor
private final class StackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
    /// Whether `top` reports the last pushed destination, or nil as a stack that cannot tell its top does.
    var knowsTop = true
}

// MARK: - Protocol conformance
extension StackSpy: StackNavigating {

    var top: AppDestination? {
        knowsTop ? pushed.last : nil
    }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }
}
