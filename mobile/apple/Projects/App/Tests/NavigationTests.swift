import Combine
import NavigatorUI
import XCTest

@testable import Semprec

final class NavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testAPushReachesTheStackOfItsTabOnly() {
        let context = NavigationContext()
        let overview = StackSpy()
        let calendar = StackSpy()
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)
        context.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertEqual(overview.pushed, [.pending(title: "Inbox")])
        XCTAssertTrue(overview.sheets.isEmpty)
        XCTAssertTrue(calendar.pushed.isEmpty)
    }

    @MainActor
    func testASheetIsPresentedOverTheStackOfItsTabOnly() {
        let context = NavigationContext()
        let overview = StackSpy()
        let journal = StackSpy()
        context.register(overview, for: .overview)
        context.register(journal, for: .journal)
        context.presentSheet(.pending(title: "Profile"), from: .journal)
        XCTAssertEqual(journal.sheets, [.pending(title: "Profile")])
        XCTAssertTrue(journal.pushed.isEmpty)
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testARouteBeforeRegistrationIsDroppedAndALaterStackReplacesTheEarlierOne() {
        let context = NavigationContext()
        context.push(.pending(title: "Inbox"), in: .overview)
        let first = StackSpy()
        context.register(first, for: .overview)
        XCTAssertTrue(first.pushed.isEmpty)
        let second = StackSpy()
        context.register(second, for: .overview)
        context.push(.pending(title: "Mail"), in: .overview)
        XCTAssertTrue(first.pushed.isEmpty)
        XCTAssertEqual(second.pushed, [.pending(title: "Mail")])
    }

    @MainActor
    func testEveryPresentedSheetIsDismissedOverEveryRegisteredStack() {
        let context = NavigationContext()
        let stacks = [AppTab.overview, .calendar, .journal].map { tab -> StackSpy in
            let stack = StackSpy()
            context.register(stack, for: tab)
            return stack
        }

        context.dismissAllPresented()

        XCTAssertEqual(stacks.map(\.dismissals), [1, 1, 1])
        context.dismissSheets(in: .calendar)
        XCTAssertEqual(stacks.map(\.dismissals), [1, 2, 1], "dismissing one tab's sheets reaches that tab only")
    }

    @MainActor
    func testDismissingEverySheetOfAnEmptyContextDoesNothing() {
        NavigationContext().dismissAllPresented()
    }

    @MainActor
    func testABlockedContextOpensNothingAndAnUnblockedOneRoutesAgain() {
        let context = NavigationContext()
        let stack = StackSpy()
        context.register(stack, for: .overview)
        var requested: [AppTab] = []
        let subscription = context.tabRequests.sink { requested.append($0) }
        var routed = 0
        context.isBlocked = true

        context.push(.pending(title: "Inbox"), in: .overview)
        context.presentSheet(.pending(title: "Profile"), from: .overview)
        context.select(.journal)
        context.whenShown(.calendar) { _ in routed += 1 }

        XCTAssertTrue(stack.pushed.isEmpty && stack.sheets.isEmpty)
        XCTAssertTrue(requested.isEmpty)
        XCTAssertEqual(routed, 0)

        context.isBlocked = false
        context.push(.pending(title: "Inbox"), in: .overview)
        context.select(.journal)
        XCTAssertEqual(stack.pushed, [.pending(title: "Inbox")])
        XCTAssertEqual(requested, [.journal])
        subscription.cancel()
    }

    @MainActor
    func testScenesDoNotShareNavigation() {
        let first = NavigationContext()
        let second = NavigationContext()
        let firstStack = StackSpy()
        let secondStack = StackSpy()
        first.register(firstStack, for: .overview)
        second.register(secondStack, for: .overview)
        first.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertEqual(firstStack.pushed, [.pending(title: "Inbox")])
        XCTAssertTrue(secondStack.pushed.isEmpty)
    }

    /// A second tap that arrives with the first asks for the destination already on top.
    @MainActor
    func testTheDestinationOnTopIsNotPushedAgainAndAnotherOneStacks() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        context.push(.pending(title: "Inbox"), in: .overview)
        context.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertEqual(overview.pushed, [.pending(title: "Inbox")])
        context.push(.pending(title: "Mail"), in: .overview)
        context.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertEqual(
            overview.pushed,
            [.pending(title: "Inbox"), .pending(title: "Mail"), .pending(title: "Inbox")]
        )
    }

    @MainActor
    func testAStackThatCannotTellItsTopTakesEveryPush() {
        let context = NavigationContext()
        let overview = StackSpy()
        overview.knowsTop = false
        context.register(overview, for: .overview)
        context.push(.pending(title: "Inbox"), in: .overview)
        context.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertEqual(overview.pushed, [.pending(title: "Inbox"), .pending(title: "Inbox")])
    }

    // MARK: - NavigatorUI stack
    /// Back, a back swipe and a pop remove entries from the end of the path without the adapter knowing.
    @MainActor
    func testTheAdapterKnowsTheTopThroughItsPushesAndThePopsOfTheStack() {
        let navigator = Navigator(configuration: .init())
        let stack = NavigatorStackAdapter(navigator)
        XCTAssertNil(stack.top)
        stack.push(.pending(title: "One"))
        stack.push(.pending(title: "Two"))
        XCTAssertEqual(navigator.count, 2)
        XCTAssertEqual(stack.top, .pending(title: "Two"))
        navigator.pop()
        XCTAssertEqual(stack.top, .pending(title: "One"))
        stack.push(.pending(title: "Three"))
        XCTAssertEqual(navigator.count, 2)
        XCTAssertEqual(stack.top, .pending(title: "Three"))
        navigator.popAll()
        XCTAssertNil(stack.top)
        stack.presentSheet(.pending(title: "Sheet"))
        XCTAssertNil(stack.top, "A sheet is no entry of the stack")
    }

    @MainActor
    func testAnEntryTheAdapterDidNotPushHidesTheTopUntilItIsPopped() {
        let navigator = Navigator(configuration: .init())
        let stack = NavigatorStackAdapter(navigator)
        stack.push(.pending(title: "One"))
        navigator.push(AppDestination.pending(title: "Two"))
        XCTAssertNil(stack.top)
        stack.push(.pending(title: "Three"))
        XCTAssertEqual(navigator.count, 3)
        XCTAssertEqual(stack.top, .pending(title: "Three"))
        navigator.pop()
        XCTAssertNil(stack.top)
        navigator.pop()
        XCTAssertEqual(stack.top, .pending(title: "One"))
    }

    @MainActor
    func testOnARealStackTheDestinationOnTopIsPushedOnceAlsoAfterABackSwipe() {
        let context = NavigationContext()
        let navigator = Navigator(configuration: .init())
        context.register(navigator, for: .overview)
        context.push(.pending(title: "Three"), in: .overview)
        context.push(.pending(title: "Three"), in: .overview)
        XCTAssertEqual(navigator.count, 1)
        context.push(.pending(title: "Four"), in: .overview)
        XCTAssertEqual(navigator.count, 2)
        navigator.pop()
        context.push(.pending(title: "Three"), in: .overview)
        XCTAssertEqual(navigator.count, 1, "Three is on top again after the back swipe")
        context.push(.pending(title: "Four"), in: .overview)
        XCTAssertEqual(navigator.count, 2)
    }

    /// The root of a stack registers its stack again each time it appears.
    @MainActor
    func testRegisteringTheSameNavigatorAgainKeepsItsAdapterAndAnotherNavigatorReplacesIt() throws {
        let context = NavigationContext()
        let navigator = Navigator(configuration: .init())
        context.register(navigator, for: .overview)
        let registered = try XCTUnwrap(context.stack(for: .overview))
        context.push(.pending(title: "Three"), in: .overview)
        context.register(navigator, for: .overview)
        XCTAssertTrue(context.stack(for: .overview) === registered)
        context.push(.pending(title: "Three"), in: .overview)
        XCTAssertEqual(navigator.count, 1)
        let other = Navigator(configuration: .init())
        context.register(other, for: .overview)
        XCTAssertFalse(context.stack(for: .overview) === registered)
        context.push(.pending(title: "Three"), in: .overview)
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
    private(set) var dismissals = 0
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

    func dismissPresented() {
        dismissals += 1
    }
}
