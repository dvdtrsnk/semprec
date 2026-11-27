import CoreKit
import XCTest

@testable import Semprec

final class CollectionsNavigationTests: XCTestCase {

    // MARK: - Properties
    private let projects = CollectionTarget.whole(databaseKey: "projects", databaseId: nil)

    // MARK: - Tests
    @MainActor
    func testTheRouterPushesAnItemAndACollectionOntoTheStackOfItsTab() {
        let context = NavigationContext()
        let overview = StackSpy()
        let calendarStack = StackSpy()
        context.register(overview, for: .overview)
        context.register(calendarStack, for: .calendar)
        let router = AppCollectionsRouter(context: context, tab: .overview)
        router.showItem(itemId: "p1", databaseKey: "projects")
        router.showCollection(projects)
        XCTAssertEqual(overview.pushed, [.collectionItem(itemId: "p1", databaseKey: "projects"), .collection(projects)])
        XCTAssertTrue(calendarStack.pushed.isEmpty)
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testARouterBelongsToOneTab() {
        let context = NavigationContext()
        let overview = StackSpy()
        let calendarStack = StackSpy()
        context.register(overview, for: .overview)
        context.register(calendarStack, for: .calendar)
        AppCollectionsRouter(context: context, tab: .calendar).showItem(itemId: "p1", databaseKey: nil)
        XCTAssertEqual(calendarStack.pushed, [.collectionItem(itemId: "p1", databaseKey: nil)])
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testAnEventOpensItsMeetingPage() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        let router = AppCollectionsRouter(context: context, tab: .overview)
        router.showEvent(itemId: "e1")
        XCTAssertEqual(overview.pushed, [.meeting(eventId: "e1", tab: .overview)])
    }

    @MainActor
    func testEachDatabaseOpensItsItemTheWayTheDesignDoes() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        let router = AppCollectionsRouter(context: context, tab: .overview)
        router.showItem(itemId: "t1", databaseKey: "tasks")
        router.showItem(itemId: "e1", databaseKey: "events")
        router.showItem(itemId: "pe1", databaseKey: "people")
        router.showItem(itemId: "j1", databaseKey: "journal")
        router.showItem(itemId: "b1", databaseKey: "books")
        router.showItem(itemId: "c1", databaseKey: "companies")
        XCTAssertEqual(
            overview.pushed,
            [
                .meeting(eventId: "e1", tab: .overview),
                .collectionItem(itemId: "pe1", databaseKey: "people"),
                .collectionItem(itemId: "j1", databaseKey: "journal")
            ]
        )
        XCTAssertEqual(
            overview.sheets,
            [
                .details(ItemDetailsTarget(kind: .task, id: "t1", tab: .overview)),
                .itemSheet(itemId: "b1", databaseKey: "books", tab: .overview),
                .itemSheet(itemId: "c1", databaseKey: "companies", tab: .overview)
            ]
        )
        XCTAssertEqual(overview.dismissals, 0)
    }

    @MainActor
    func testTheRouterOfAnItemSheetClosesTheSheetBeforeEachRoute() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        let router = AppCollectionsRouter(context: context, tab: .overview, closesSheet: true)
        router.showItem(itemId: "p1", databaseKey: "projects")
        router.showCollection(projects)
        router.showEvent(itemId: "e1")
        router.showProjectMail(projectId: "p1")
        router.showProjectMailSignals(projectId: "p1")
        router.showProjectNotes(projectId: "p1")
        router.showProjectAgent(projectId: "p1")
        router.showProjectTasks(projectId: "p1")
        XCTAssertEqual(overview.dismissals, 8)
        XCTAssertEqual(overview.pushed.count, 8)
    }

    @MainActor
    func testTheTasksOfAProjectOpenAllItsTasksOnTheStackOfTheCollection() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        AppCollectionsRouter(context: context, tab: .overview).showProjectTasks(projectId: "p1")
        XCTAssertEqual(overview.pushed, [.tasks(TasksStart(tab: .all, projectId: "p1"), tab: .overview)])
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testTheAgentOfAProjectOpensTheSempProjectAgentOnTheStackOfTheCollection() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        AppCollectionsRouter(context: context, tab: .overview).showProjectAgent(projectId: "p1")
        XCTAssertEqual(overview.pushed, [.sempProjectAgent(projectId: "p1")])
    }

    @MainActor
    func testTheMailSignalsOfAProjectOpenOnTheStackOfTheCollection() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        AppCollectionsRouter(context: context, tab: .overview).showProjectMailSignals(projectId: "p1")
        XCTAssertEqual(overview.pushed, [.projectMailSignals(projectId: "p1")])
        XCTAssertTrue(overview.sheets.isEmpty)
        XCTAssertFalse(AppDestination.projectMailSignals(projectId: "p1").presentsAsSheet)
    }

    @MainActor
    func testTheNotesOfAProjectOpenTheNotesScreenOnTheStackOfTheCollection() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        AppCollectionsRouter(context: context, tab: .overview).showProjectNotes(projectId: "p1")
        XCTAssertEqual(overview.pushed, [.notes(itemId: "p1", tab: .overview)])
    }

    @MainActor
    func testTheMailOfAProjectOpensItsThreadListOnTheStackOfTheTab() {
        let context = NavigationContext()
        let overview = StackSpy()
        let calendarStack = StackSpy()
        context.register(overview, for: .overview)
        context.register(calendarStack, for: .calendar)
        AppCollectionsRouter(context: context, tab: .calendar).showProjectMail(projectId: "p1")
        XCTAssertEqual(
            calendarStack.pushed,
            [.mailList(MailListStart(projectId: "p1"), title: nil, tab: .calendar)]
        )
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testARouteBeforeTheStackIsRegisteredIsDroppedAndTheSameItemOnTopIsNotPushedTwice() {
        let context = NavigationContext()
        let router = AppCollectionsRouter(context: context, tab: .overview)
        router.showItem(itemId: "p1", databaseKey: "projects")
        let overview = StackSpy()
        context.register(overview, for: .overview)
        XCTAssertTrue(overview.pushed.isEmpty)
        router.showItem(itemId: "p1", databaseKey: "projects")
        router.showItem(itemId: "p1", databaseKey: "projects")
        XCTAssertEqual(overview.pushed, [.collectionItem(itemId: "p1", databaseKey: "projects")])
    }
}

// MARK: - Spies
@MainActor
private final class StackSpy: StackNavigating {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
    var dismissals = 0

    // MARK: - Protocol conformance
    var top: AppDestination? { pushed.last }

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
