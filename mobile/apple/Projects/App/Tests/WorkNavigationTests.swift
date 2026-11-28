import CoreKit
import NavigatorUI
import SwiftUI
import XCTest

@testable import Alldots

/// The routes of the Tasks screen and of the Podrobnosti sheet: which stack they reach, and how.
final class WorkNavigationTests: XCTestCase {

    // MARK: - Context
    @MainActor
    func testTheDetailsSheetIsPresentedOverTheStackThatAskedForIt() throws {
        let context = NavigationContext()
        let overview = Navigator(configuration: .init())
        let calendar = Navigator(configuration: .init())
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)

        context.showDetails(kind: .event, id: "e1", from: .calendar)

        XCTAssertEqual(
            calendar.presentingSheetOrCover as? AppDestination,
            .details(ItemDetailsTarget(kind: .event, id: "e1"))
        )
        XCTAssertNil(overview.presentingSheetOrCover)
        XCTAssertEqual(calendar.count, 0, "The sheet is presented, not pushed")
    }

    @MainActor
    func testTheTasksScreenIsPushedOnceOntoTheStackOfItsTab() {
        let context = NavigationContext()
        let overview = Navigator(configuration: .init())
        let journal = Navigator(configuration: .init())
        context.register(overview, for: .overview)
        context.register(journal, for: .journal)
        let start = TasksStart(tab: .all, hideDone: true)

        context.showTasks(start, in: .overview)
        context.showTasks(start, in: .overview)

        XCTAssertEqual(overview.count, 1, "A second request for the screen on top is dropped")
        XCTAssertEqual(journal.count, 0)
        context.showTasks(TasksStart(projectId: "ios"), in: .overview)
        XCTAssertEqual(overview.count, 2, "Another start of the screen stacks on top of it")
    }

    @MainActor
    func testARouteBeforeTheStackRegisteredIsDropped() {
        let context = NavigationContext()
        context.showTasks(TasksStart(), in: .overview)
        context.showDetails(kind: .task, id: "t1", from: .overview)
        let navigator = Navigator(configuration: .init())
        context.register(navigator, for: .overview)
        XCTAssertEqual(navigator.count, 0)
        XCTAssertNil(navigator.presentingSheetOrCover)
    }

    // MARK: - Router
    @MainActor
    func testTheTasksRouterOpensTheDetailsOfATaskOverItsOwnTab() {
        let composition = AppComposition(models: SignedInModels())
        let overview = Navigator(configuration: .init())
        let journal = Navigator(configuration: .init())
        composition.navigation.register(overview, for: .overview)
        composition.navigation.register(journal, for: .journal)

        composition.tasksRouter(in: .journal).showDetails(taskId: "t9")

        XCTAssertEqual(
            journal.presentingSheetOrCover as? AppDestination,
            .details(ItemDetailsTarget(kind: .task, id: "t9"))
        )
        XCTAssertNil(overview.presentingSheetOrCover)
    }

    // MARK: - Scene
    @MainActor
    func testInARealSceneTheTasksScreenIsPushedAndPodrobnostiIsPresentedAsASheet() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let overview = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.navigation.showTasks(TasksStart(), in: .overview)
        XCTAssertEqual(overview.navigator.count, 1)
        let tasks = try Copy.text("tasks.title")
        try await eventually { window.stackTitle == tasks }
        XCTAssertEqual(window.stackTitle, tasks, "The Overview tab must show the Tasks screen on top")

        scene.navigation.showDetails(kind: .task, id: "t1", from: .overview)
        XCTAssertEqual(
            overview.navigator.presentingSheetOrCover as? AppDestination,
            .details(ItemDetailsTarget(kind: .task, id: "t1"))
        )
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the Podrobnosti sheet")
        window.close()
    }
}

// MARK: - Copy
/// Texts of the Tasks feature, in the language of the test scheme, from its String Catalog.
private enum Copy {

    static func text(_ key: String) throws -> String {
        let app = try XCTUnwrap(Bundle.main.bundleIdentifier, "The tests must run in the app")
        let bundle = try XCTUnwrap(Bundle(identifier: "\(app).TasksFeature"), "The app must load TasksFeature")
        let text = bundle.localizedString(forKey: key, value: nil, table: nil)
        XCTAssertNotEqual(text, key, "TasksFeature must have a text for \(key)")
        return text
    }
}
