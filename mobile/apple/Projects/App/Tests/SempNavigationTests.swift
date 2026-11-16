import CoreKit
import XCTest

@testable import Semprec

final class SempNavigationTests: XCTestCase {

    // MARK: - Helpers
    @MainActor
    private func router(
        insideChat: Bool,
        presenter: SempChatPresenter,
        context: NavigationContext,
        tab: AppTab = .calendar
    ) -> AppSempRouter {
        AppSempRouter(presenter: presenter, context: context, tab: { tab }, insideChat: insideChat)
    }

    // MARK: - Presenter
    @MainActor
    func testPresentingOpensTheChatOnARouteAndClearsWhatWasPushed() {
        let presenter = SempChatPresenter()
        presenter.present(.chats)
        presenter.push(.approvals)
        XCTAssertTrue(presenter.isPresented)
        XCTAssertEqual(presenter.root, .chats)
        XCTAssertEqual(presenter.path, [.approvals])

        presenter.present()
        XCTAssertEqual(presenter.root, .latest)
        XCTAssertEqual(presenter.path, [])
        presenter.dismiss()
        XCTAssertFalse(presenter.isPresented)
    }

    // MARK: - Inside the chat
    @MainActor
    func testTheRouterOfAChatPageAddsPagesToTheChatsOwnStack() {
        let presenter = SempChatPresenter()
        let tabStack = SempStackSpy()
        let context = NavigationContext()
        context.register(tabStack, for: .calendar)
        let router = router(insideChat: true, presenter: presenter, context: context)
        presenter.present()

        router.showHistory()
        router.showNewChat()
        router.showThread(threadId: "t1", type: .tick, title: "Weekly")
        router.showChat(threadId: "t2", messageId: "m")
        router.showRun(runId: "r", messageId: "a")
        router.showApprovals()
        router.showStatus()

        XCTAssertEqual(
            presenter.path,
            [
                .chats,
                .new,
                .thread(start: .existing, threadId: "t1", inboxItemId: nil, title: "Weekly", meta: nil),
                .thread(start: .existing, threadId: "t2", inboxItemId: nil, title: nil, meta: nil),
                .run(runId: "r", messageId: "a"),
                .approvals,
                .status
            ]
        )
        XCTAssertTrue(tabStack.pushed.isEmpty)
        XCTAssertTrue(presenter.isPresented)
    }

    // MARK: - Outside the chat
    @MainActor
    func testTheRouterOfATabPageOpensTheChatOnTheRequestedPage() {
        let presenter = SempChatPresenter()
        let router = router(insideChat: false, presenter: presenter, context: NavigationContext())

        router.showThread(threadId: "t1", type: .tick, title: nil)

        XCTAssertTrue(presenter.isPresented)
        XCTAssertEqual(
            presenter.root,
            .thread(start: .existing, threadId: "t1", inboxItemId: nil, title: nil, meta: nil)
        )
        router.showRun(runId: "r", messageId: nil)
        XCTAssertEqual(presenter.root, .run(runId: "r", messageId: nil))
        XCTAssertEqual(presenter.path, [])
    }

    @MainActor
    func testAnInboxItemDroppedOnTheBubbleOpensItsThreadInTheChat() {
        let presenter = SempChatPresenter()
        router(insideChat: false, presenter: presenter, context: NavigationContext())
            .showItemThread(inboxItemId: "i1", title: "Call", meta: "today")

        XCTAssertTrue(presenter.isPresented)
        XCTAssertEqual(
            presenter.root,
            .thread(start: .item, threadId: nil, inboxItemId: "i1", title: "Call", meta: "today")
        )
    }

    // MARK: - Leaving the chat
    @MainActor
    func testAnItemAProjectOrATaskOpensInTheCurrentTabAfterTheChatClosed() async throws {
        let presenter = SempChatPresenter()
        let context = NavigationContext()
        let stack = SempStackSpy()
        context.register(stack, for: .calendar)
        let router = router(insideChat: true, presenter: presenter, context: context, tab: .calendar)
        presenter.present()

        router.showProject(projectId: "p1")
        router.showItem(itemId: "t1", databaseKey: "tasks")
        router.showItem(itemId: "e1", databaseKey: "events")
        router.showItem(itemId: "x1", databaseKey: "people")
        XCTAssertFalse(presenter.isPresented)

        try await eventually { stack.pushed.count == 2 && stack.sheets.count == 2 }
        XCTAssertEqual(
            Set(stack.pushed),
            [
                .collectionItem(itemId: "p1", databaseKey: "projects"),
                .collectionItem(itemId: "x1", databaseKey: "people")
            ]
        )
        XCTAssertEqual(
            Set(stack.sheets),
            [.details(ItemDetailsTarget(kind: .task, id: "t1")), .details(ItemDetailsTarget(kind: .event, id: "e1"))]
        )
    }

    // MARK: - Destinations
    @MainActor
    func testTheProjectAgentOpensFromAProjectOnItsTabsStack() {
        let context = NavigationContext()
        let stack = SempStackSpy()
        context.register(stack, for: .overview)

        AppCollectionsRouter(context: context, tab: .overview).showProjectAgent(projectId: "p1")

        XCTAssertEqual(stack.pushed, [.sempProjectAgent(projectId: "p1")])
    }

    func testOnlyTheDestinationsPresentedAsSheetsGetTheirOwnBubble() {
        XCTAssertTrue(AppDestination.profile.presentsAsSheet)
        XCTAssertTrue(AppDestination.calendars.presentsAsSheet)
        XCTAssertTrue(AppDestination.newItem(day: "2026-10-21").presentsAsSheet)
        XCTAssertFalse(AppDestination.sempProjectAgent(projectId: "p").presentsAsSheet)
        XCTAssertFalse(AppDestination.sempStatus.presentsAsSheet)
        XCTAssertFalse(AppDestination.collectionItem(itemId: "i", databaseKey: nil).presentsAsSheet)
    }
}

// MARK: - Spies
@MainActor
private final class SempStackSpy: StackNavigating {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []

    // MARK: - Protocol conformance
    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }
}
