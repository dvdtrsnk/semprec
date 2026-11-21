import Combine
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
        XCTAssertEqual(overview.sheets, [.profile()])
        XCTAssertTrue(overview.pushed.isEmpty)
        XCTAssertTrue(calendar.sheets.isEmpty)
    }

    @MainActor
    func testTheInboxRowOpensTheInboxOnTheOverviewStack() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        AppOverviewRouter(context: context).show(.inbox)
        XCTAssertEqual(overview.pushed, [.inbox(tab: .overview)])
    }

    @MainActor
    func testTheFinanceRowOpensANoticeThatNamesItOnTheOverviewStack() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        AppOverviewRouter(context: context).show(.finance)
        guard overview.pushed.count == 1, case .pending(let title) = overview.pushed[0] else {
            return XCTFail("The finance row must open a notice, got \(overview.pushed)")
        }
        XCTAssertFalse(title.hasPrefix("pending."), "The title must be read from the catalog")
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testTheJournalRowSelectsTheJournalTabAndPushesNothing() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        var selected: [AppTab] = []
        let subscription = context.tabRequests.sink { selected.append($0) }
        AppOverviewRouter(context: context).show(.journal(itemId: "j1"))
        AppOverviewRouter(context: context).show(.journal(itemId: nil))
        subscription.cancel()
        XCTAssertEqual(selected, [.journal, .journal])
        XCTAssertTrue(overview.pushed.isEmpty)
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    @MainActor
    func testAPinnedProjectRowPushesTheProjectOntoTheOverviewStack() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        AppOverviewRouter(context: context).show(.project(id: "p"))
        XCTAssertEqual(overview.pushed, [.collectionItem(itemId: "p", databaseKey: "projects")])
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
    func testTheMailRowPushesTheThreadListOntoTheOverviewStack() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        AppOverviewRouter(context: context).show(.mail)
        XCTAssertEqual(overview.pushed, [.mailList(MailListStart(), title: nil, tab: .overview)])
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
    func testProjectAreaContactFileAndMailResultsOpenTheirScreens() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        let router = AppOverviewRouter(context: context)
        router.showSearchResult(link(.project, "p1"))
        router.showSearchResult(link(.area, "a1"))
        router.showSearchResult(link(.contact, "c1"))
        router.showSearchResult(link(.file, "f1"))
        router.showSearchResult(
            SearchResultLink(
                type: .mail, itemId: nil, threadId: "t1", databaseKey: nil, journalType: nil, journalPeriod: nil
            )
        )
        XCTAssertEqual(
            overview.pushed,
            [
                .collectionItem(itemId: "p1", databaseKey: "projects"),
                .area(areaId: "a1", tab: .overview),
                .collectionItem(itemId: "c1", databaseKey: nil),
                .collectionItem(itemId: "f1", databaseKey: nil),
                .mailThread(threadId: "t1", tab: .overview)
            ]
        )
    }

    @MainActor
    func testAJournalResultSelectsTheJournalTab() {
        let context = NavigationContext()
        let overview = OverviewStackSpy()
        context.register(overview, for: .overview)
        var selected: [AppTab] = []
        let subscription = context.tabRequests.sink { selected.append($0) }
        AppOverviewRouter(context: context).showSearchResult(link(.journal, "j1"))
        subscription.cancel()
        XCTAssertEqual(selected, [.journal])
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testAResultWithoutAScreenOpensANotice() {
        for result in [link(.chat, "c1"), link(.task, nil), link(.mail, nil)] {
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
        XCTAssertEqual(overview.navigator.presentingSheetOrCover as? AppDestination, .profile())
        XCTAssertEqual(overview.navigator.count, 0, "The profile must be presented, not pushed")
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the profile sheet")
        window.close()
    }

    @MainActor
    func testTheRealSceneOpensTheInboxRowOnTheOverviewStack() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let overview = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.overviewRouter.show(.inbox)
        XCTAssertEqual(overview.navigator.count, 1, "The Inbox must be pushed onto the Overview stack")
        try await eventually { window.stackTitle == "Inbox" }
        XCTAssertEqual(window.stackTitle, "Inbox")
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

    func dismissPresented() {}
}
