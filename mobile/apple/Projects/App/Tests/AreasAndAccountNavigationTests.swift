import CoreKit
import XCTest

@testable import Semprec

/// The routes of the area screen and of the profile sheet: which stack they reach and how.
final class AreasAndAccountNavigationTests: XCTestCase {

    // MARK: - Areas
    @MainActor
    func testTheTasksOfAnAreaOpenOnTheStackThatAskedForThem() {
        let context = NavigationContext()
        let overview = AreaStackSpy()
        let calendar = AreaStackSpy()
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)
        let router = AppAreasRouter(context: context, tab: .calendar)
        router.showTasks(areaId: "a1", todayOnly: true)
        router.showTasks(areaId: "a1", todayOnly: false)
        XCTAssertEqual(
            calendar.pushed,
            [
                .tasks(TasksStart(tab: .today, hideDone: false, areaId: "a1"), tab: .calendar),
                .tasks(TasksStart(tab: .all, hideDone: true, areaId: "a1"), tab: .calendar)
            ]
        )
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testAnUpcomingItemOpensItsPodrobnostiAsASheetAndACollectionIsPushed() {
        let context = NavigationContext()
        let overview = AreaStackSpy()
        context.register(overview, for: .overview)
        let router = AppAreasRouter(context: context, tab: .overview)
        router.showDetails(kind: .event, id: "e1")
        let target = CollectionTarget.matching(databaseKey: "files", databaseId: "d1", filterJson: "{}")
        router.showCollection(target)
        XCTAssertEqual(overview.sheets, [.details(ItemDetailsTarget(kind: .event, id: "e1"))])
        XCTAssertEqual(overview.pushed, [.collection(target)])
    }

    @MainActor
    func testTheMailOfAnAreaOpensItsThreadListAndItsNotesOpenTheNotesScreen() {
        let context = NavigationContext()
        let overview = AreaStackSpy()
        context.register(overview, for: .overview)
        let router = AppAreasRouter(context: context, tab: .overview)
        router.showMail(areaId: "a1")
        router.showNotes(areaId: "a1")
        XCTAssertEqual(overview.pushed.count, 2)
        XCTAssertEqual(overview.pushed[0], .mailList(MailListStart(areaId: "a1"), title: nil, tab: .overview))
        XCTAssertEqual(overview.pushed[1], .notes(itemId: "a1", tab: .overview))
    }

    // MARK: - Notes
    @MainActor
    func testASubpageOpensAnotherNotesPageWithTheTitlesAboveIt() {
        let context = NavigationContext()
        let calendar = AreaStackSpy()
        context.register(calendar, for: .calendar)
        let router = AppNotesRouter(context: context, tab: .calendar)
        router.showPage(itemId: "page-1", trail: ["Notes", "Trip"], focusTitle: true)
        XCTAssertEqual(
            calendar.pushed,
            [.notes(itemId: "page-1", tab: .calendar, trail: ["Notes", "Trip"], focusTitle: true)]
        )
    }

    // MARK: - Profile
    @MainActor
    func testARowOfTheProfileAppendsItsPageToTheSheetsOwnStackOnce() {
        let path = AccountPath()
        let router = AppAccountRouter(path: path, context: NavigationContext(), dismissSheet: {}, requestPermission: {})
        router.show(.devices)
        router.show(.devices)
        router.show(.trash)
        XCTAssertEqual(path.pages, [.page(.devices), .page(.trash)])
        router.show(.devices)
        XCTAssertEqual(
            path.pages,
            [.page(.devices), .page(.trash), .page(.devices)],
            "Only the page on top is not pushed again"
        )
    }

    @MainActor
    func testTheInternetAccountsAndAnAccountArePagesOfTheSheetsOwnStack() {
        let context = NavigationContext()
        let overview = AreaStackSpy()
        context.register(overview, for: .overview)
        let path = AccountPath()
        var dismissals = 0
        var permissionRequests = 0
        let router = AppAccountRouter(
            path: path,
            context: context,
            dismissSheet: { dismissals += 1 },
            requestPermission: { permissionRequests += 1 }
        )
        router.show(.internetAccounts)
        router.showInternetAccount(accountId: "m1")
        router.showInternetAccount(accountId: "m1")
        router.requestNotificationPermission()
        XCTAssertEqual(path.pages, [.page(.internetAccounts), .internetAccount(accountId: "m1")])
        XCTAssertEqual(dismissals, 0)
        XCTAssertEqual(permissionRequests, 1)
        XCTAssertTrue(overview.pushed.isEmpty, "The accounts are not on the Overview stack any more")
    }

    @MainActor
    func testTheSempStatusRowClosesTheSheetAndOpensTheStatusOnTheOverviewStack() {
        let context = NavigationContext()
        let overview = AreaStackSpy()
        context.register(overview, for: .overview)
        let path = AccountPath()
        var dismissals = 0
        let router = AppAccountRouter(
            path: path,
            context: context,
            dismissSheet: { dismissals += 1 },
            requestPermission: {}
        )
        router.show(.sempStatus)
        XCTAssertEqual(dismissals, 1)
        XCTAssertEqual(overview.pushed, [.sempStatus])
        XCTAssertTrue(path.pages.isEmpty, "The status is not a page of the sheet's own stack")
    }
}

// MARK: - Spies
@MainActor
private final class AreaStackSpy: StackNavigating {

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

    func dismissPresented() {}
}
