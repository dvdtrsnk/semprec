import CoreKit
import NavigatorUI
import OverviewFeature
import SwiftUI
import XCTest

@testable import Semprec

/// What the overview's rows and its profile button do in the app: the router changes the stack of the Overview tab,
/// and the real scene shows the result.
final class OverviewRoutingTests: XCTestCase {

    // MARK: - Router
    @MainActor
    func testTheProfileButtonPresentsTheProfileAsASheetOverTheOverviewStack() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        let calendar = OverviewStackSpy()
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)
        AppOverviewRouter(context: context).show(.profile)
        XCTAssertEqual(overview.sheets, [.profile])
        XCTAssertTrue(overview.pushed.isEmpty)
        XCTAssertTrue(calendar.sheets.isEmpty)
    }

    @MainActor
    func testEveryRowOpensANoticeThatNamesItOnTheOverviewStack() {
        let targets: [OverviewTarget] = [
            .inbox, .mail, .finance, .journal(itemId: "j1"), .project(id: "p")
        ]
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        let router = AppOverviewRouter(context: context)
        for target in targets { router.show(target) }
        XCTAssertEqual(overview.pushed.count, targets.count)
        let titles = overview.pushed.compactMap { destination -> String? in
            if case .pending(let title) = destination { title } else { nil }
        }
        XCTAssertEqual(titles.count, targets.count, "Every row must open a notice")
        XCTAssertEqual(Set(titles).count, targets.count, "Each notice must name its own row")
        XCTAssertFalse(titles.contains { $0.hasPrefix("pending.") }, "The titles must be read from the catalog")
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testAnAreaRowPushesTheAreaScreenAndACollectionRowPushesItsCollection() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        let router = AppOverviewRouter(context: context)
        router.show(.area(id: "a1"))
        router.show(.collection(ownerModuleId: "books", databaseId: "d1"))
        XCTAssertEqual(
            overview.pushed,
            [.area(areaId: "a1", tab: .overview), .collection(.whole(databaseKey: nil, databaseId: "d1"))]
        )
    }

    @MainActor
    func testTheTasksRowPushesTheTasksScreenOntoTheOverviewStack() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        AppOverviewRouter(context: context).show(.tasks)
        XCTAssertEqual(overview.pushed, [.tasks(TasksStart(), tab: .overview)])
    }

    @MainActor
    func testATaskOrEventSearchResultOpensItsPodrobnostiAsASheet() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        let router = AppOverviewRouter(context: context)
        router.showSearchResult(link(.task, "t1"))
        router.showSearchResult(link(.event, "e1"))
        XCTAssertEqual(
            overview.sheets,
            [.details(ItemDetailsTarget(kind: .task, id: "t1")), .details(ItemDetailsTarget(kind: .event, id: "e1"))]
        )
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testAResultOfAScreenAnotherWaveBuildsOpensANotice() {
        for result in [link(.project, "p1"), link(.task, nil)] {
            let context = NavigationContext()
            let overview = OverviewStackSpy()
            context.register(overview, for: .overview)
            AppOverviewRouter(context: context).showSearchResult(result)
            XCTAssertEqual(overview.pushed.count, 1)
            XCTAssertTrue(overview.sheets.isEmpty)
        }
    }

    @MainActor
    func testARouteBeforeTheStackRegistersIsDropped() {
        let context = NavigationContext()
        AppOverviewRouter(context: context).show(.profile)
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    // MARK: - Scene
    @MainActor
    func testTheRealSceneShowsTheOverviewAndPresentsTheProfileSheet() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let overview = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.overviewRouter.show(.profile)
        XCTAssertEqual(overview.navigator.presentingSheetOrCover as? AppDestination, .profile)
        XCTAssertEqual(overview.navigator.count, 0, "The profile must be presented, not pushed")
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the profile sheet")
        window.close()
    }

    @MainActor
    func testTheRealSceneOpensARowOnTheOverviewStack() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let overview = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.overviewRouter.show(.inbox)
        XCTAssertEqual(overview.navigator.count, 1, "The notice must be pushed onto the Overview stack")
        let title = String(localized: "pending.inbox")
        try await eventually { window.stackTitle == title }
        XCTAssertEqual(window.stackTitle, title)
        window.close()
    }
}

// MARK: - Helpers
private func link(_ type: SearchGroupType, _ itemId: String?) -> SearchResultLink {
    SearchResultLink(
        type: type,
        itemId: itemId,
        threadId: nil,
        databaseKey: nil,
        journalType: nil,
        journalPeriod: nil
    )
}

// MARK: - Spies
@MainActor
private final class OverviewStackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension OverviewStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }
}
