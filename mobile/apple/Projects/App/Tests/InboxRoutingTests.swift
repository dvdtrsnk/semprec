import XCTest

@testable import Semprec

final class InboxRoutingTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testATaskAndAnEventOpenAsPodrobnostiOverTheStackOfTheInbox() {
        let (router, stack) = makeRouter()
        router.showItem(databaseKey: "tasks", itemId: "t1")
        router.showItem(databaseKey: "events", itemId: "e1")
        XCTAssertEqual(
            stack.sheets,
            [.details(ItemDetailsTarget(kind: .task, id: "t1")), .details(ItemDetailsTarget(kind: .event, id: "e1"))]
        )
        XCTAssertTrue(stack.pushed.isEmpty)
    }

    @MainActor
    func testAnyOtherItemOpensAsTheGenericItemOnTheStackOfTheInbox() {
        let (router, stack) = makeRouter()
        router.showItem(databaseKey: "projects", itemId: "p1")
        router.showItem(databaseKey: nil, itemId: "x1")
        XCTAssertEqual(
            stack.pushed,
            [.collectionItem(itemId: "p1", databaseKey: "projects"), .collectionItem(itemId: "x1", databaseKey: nil)]
        )
        XCTAssertTrue(stack.sheets.isEmpty)
    }

    @MainActor
    func testTheInboxOfATabIsPushedOntoThatTab() {
        let context = NavigationContext()
        let overview = InboxStackSpy()
        let calendar = InboxStackSpy()
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)
        context.showInbox(in: .overview)
        XCTAssertEqual(overview.pushed, [.inbox(tab: .overview)])
        XCTAssertTrue(calendar.pushed.isEmpty)
    }

    // MARK: - Helpers
    @MainActor
    private func makeRouter() -> (AppInboxRouter, InboxStackSpy) {
        let context = NavigationContext()
        let stack = InboxStackSpy()
        context.register(stack, for: .overview)
        return (AppInboxRouter(context: context, tab: .overview), stack)
    }
}

// MARK: - Spies
@MainActor
private final class InboxStackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension InboxStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }
}
