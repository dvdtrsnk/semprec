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
        let home = StackSpy()
        let settings = StackSpy()
        context.register(home, for: .home)
        context.register(settings, for: .settings)
        let router = AppCollectionsRouter(context: context, tab: .home)
        router.showItem(itemId: "p1", databaseKey: "projects")
        router.showCollection(projects)
        XCTAssertEqual(home.pushed, [.collectionItem(itemId: "p1", databaseKey: "projects"), .collection(projects)])
        XCTAssertTrue(settings.pushed.isEmpty)
        XCTAssertTrue(home.sheets.isEmpty)
    }

    @MainActor
    func testARouterBelongsToOneTab() {
        let context = NavigationContext()
        let home = StackSpy()
        let settings = StackSpy()
        context.register(home, for: .home)
        context.register(settings, for: .settings)
        AppCollectionsRouter(context: context, tab: .settings).showItem(itemId: "p1", databaseKey: nil)
        XCTAssertEqual(settings.pushed, [.collectionItem(itemId: "p1", databaseKey: nil)])
        XCTAssertTrue(home.pushed.isEmpty)
    }

    @MainActor
    func testAnEventAndAnAreaOpenAsTheGenericItemUntilTheirOwnScreensAreMapped() {
        let context = NavigationContext()
        let home = StackSpy()
        context.register(home, for: .home)
        let router = AppCollectionsRouter(context: context, tab: .home)
        router.showEvent(itemId: "e1")
        router.showArea(areaId: "a1")
        XCTAssertEqual(
            home.pushed,
            [.collectionItem(itemId: "e1", databaseKey: "events"), .collectionItem(itemId: "a1", databaseKey: "areas")]
        )
    }

    @MainActor
    func testTheScreensOfOtherFeaturesAreNotRoutedYet() {
        let context = NavigationContext()
        let home = StackSpy()
        context.register(home, for: .home)
        let router = AppCollectionsRouter(context: context, tab: .home)
        router.showProjectTasks(projectId: "p1")
        router.showProjectMail(projectId: "p1")
        router.showProjectNotes(projectId: "p1")
        router.showProjectAgent(projectId: "p1")
        XCTAssertTrue(home.pushed.isEmpty)
        XCTAssertTrue(home.sheets.isEmpty)
    }

    @MainActor
    func testARouteBeforeTheStackIsRegisteredIsDroppedAndTheSameItemOnTopIsNotPushedTwice() {
        let context = NavigationContext()
        let router = AppCollectionsRouter(context: context, tab: .home)
        router.showItem(itemId: "p1", databaseKey: "projects")
        let home = StackSpy()
        context.register(home, for: .home)
        XCTAssertTrue(home.pushed.isEmpty)
        router.showItem(itemId: "p1", databaseKey: "projects")
        router.showItem(itemId: "p1", databaseKey: "projects")
        XCTAssertEqual(home.pushed, [.collectionItem(itemId: "p1", databaseKey: "projects")])
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
