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
    func testAnEventOpensAsTheGenericItemAndAnAreaOpensItsOwnScreen() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        let router = AppCollectionsRouter(context: context, tab: .overview)
        router.showEvent(itemId: "e1")
        router.showArea(areaId: "a1")
        XCTAssertEqual(
            overview.pushed,
            [.collectionItem(itemId: "e1", databaseKey: "events"), .area(areaId: "a1", tab: .overview)]
        )
    }

    @MainActor
    func testTheScreensOfOtherFeaturesAreNotRoutedYet() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        let router = AppCollectionsRouter(context: context, tab: .overview)
        router.showProjectTasks(projectId: "p1")
        router.showProjectAgent(projectId: "p1")
        XCTAssertTrue(overview.pushed.isEmpty)
        XCTAssertTrue(overview.sheets.isEmpty)
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

    // MARK: - Protocol conformance
    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }
}
