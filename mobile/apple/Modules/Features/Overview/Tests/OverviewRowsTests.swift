import CoreKit
import XCTest

@testable import OverviewFeature

final class OverviewRowsTests: XCTestCase {

    // MARK: - Main
    func testTheMainRowsLeadToTheirTargetsInOrder() {
        let rows = OverviewRows.main(OverviewContent(journalTodayItemId: "j1"))
        XCTAssertEqual(
            rows.map(\.target),
            [.inbox, .mail, .recordings, .journal(itemId: "j1"), .tasks, .finance]
        )
        XCTAssertEqual(Set(rows.map(\.identifier)).count, rows.count)
    }

    func testTheInboxWaitsOnARedBadgeAndTheMailShowsItsCountOnlyWhenThereIsSomething() {
        let busy = OverviewRows.main(OverviewContent(inboxPending: 9, mailUnread: 5, tasksToday: 4))
        XCTAssertEqual(busy[0].trailing, .badge(9))
        XCTAssertEqual(busy[1].trailing, .count(5))
        XCTAssertEqual(busy[4].trailing, .count(4))
        let quiet = OverviewRows.main(OverviewContent())
        XCTAssertEqual(quiet[0].trailing, .none)
        XCTAssertEqual(quiet[1].trailing, .none)
        XCTAssertEqual(quiet[4].trailing, .count(0), "Today's tasks are counted even when there are none")
    }

    func testTheJournalRowSaysTodayWhateverTheEntry() {
        XCTAssertEqual(OverviewRows.main(OverviewContent())[3].trailing, .today)
        XCTAssertEqual(OverviewRows.main(OverviewContent())[3].target, .journal(itemId: nil))
    }

    // MARK: - Areas, projects, collections
    func testAreaRowsCountTheirActiveProjectsOnlyWhenThereAreAny() {
        let rows = OverviewRows.areas(
            OverviewContent(areas: [
                OverviewArea(id: "a", name: "Work", color: "#5856D6", icon: "briefcase", activeProjectCount: 6),
                OverviewArea(id: "b", name: "Home", color: nil, icon: nil, activeProjectCount: 0)
            ])
        )
        XCTAssertEqual(rows.map(\.target), [.area(id: "a"), .area(id: "b")])
        XCTAssertEqual(rows.map(\.trailing), [.count(6), .none])
        XCTAssertEqual(rows.map(\.symbol), ["briefcase", OverviewSymbols.areaFallback])
    }

    func testProjectRowsNameTheirAreaAndStatus() {
        let content = OverviewContent(projects: [
            OverviewProject(id: "p1", name: "Semprec", color: "#007AFF", areaName: "Work", status: "inProgress"),
            OverviewProject(id: "p2", name: "Loose", color: nil, areaName: nil, status: nil),
            OverviewProject(id: "p3", name: "Odd", color: nil, areaName: "Home", status: "unheard")
        ])
        XCTAssertEqual(
            OverviewRows.projects(content).map(\.target),
            [.project(id: "p1"), .project(id: "p2"), .project(id: "p3")]
        )
        XCTAssertEqual(OverviewRows.subtitle(of: content.projects[0]), "Work \u{00B7} In progress")
        XCTAssertNil(OverviewRows.subtitle(of: content.projects[1]))
        XCTAssertEqual(OverviewRows.subtitle(of: content.projects[2]), "Home")
    }

    func testEveryProjectStatusHasItsWords() {
        for key in ["inProgress", "longTerm", "done", "archived"] {
            XCTAssertNotNil(OverviewRows.status(key), key)
        }
        XCTAssertNil(OverviewRows.status("unheard"))
        XCTAssertNil(OverviewRows.status(nil))
    }

    func testCollectionRowsCountTheirItemsAndOpenTheirCollection() {
        let rows = OverviewRows.collections(
            OverviewContent(collections: [
                OverviewCollection(
                    databaseId: "d1", ownerModuleId: "events", name: "Events",
                    icon: "calendar", color: "#FF3B30", itemCount: 214
                )
            ])
        )
        XCTAssertEqual(rows.map(\.trailing), [.count(214)])
        XCTAssertEqual(rows.map(\.target), [.collection(ownerModuleId: "events", databaseId: "d1")])
        XCTAssertEqual(rows.map(\.identifier), [OverviewIdentifiers.collectionPrefix + "events"])
    }

    // MARK: - Search scopes
    func testEverySearchScopeHasOneChipAndAllComesFirst() {
        XCTAssertEqual(SearchScope.all.count, SearchGroupType.allCases.count + 1)
        XCTAssertNil(SearchScope.all[0].type)
        XCTAssertEqual(Set(SearchScope.all.map(\.identifier)).count, SearchScope.all.count)
    }
}
