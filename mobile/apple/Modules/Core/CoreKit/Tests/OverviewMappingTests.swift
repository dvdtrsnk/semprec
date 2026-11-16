import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the Overview and Search bridges' mappings between Kotlin and Swift values with Kotlin values
/// built here. Both modules declare most of these type names, so each is qualified with its module.
final class OverviewMappingTests: XCTestCase {

    // MARK: - Overview state
    @MainActor
    func testOverviewMapsLoadingAndFailure() {
        XCTAssertEqual(SharedOverviewScreenModel.state(overviewState(.loading)), .loading)
        XCTAssertEqual(
            SharedOverviewScreenModel.state(overviewState(.error, failure: .unauthorized)),
            .failure(.unauthorized)
        )
        XCTAssertEqual(SharedOverviewScreenModel.state(overviewState(.error)), .failure(nil))
    }

    @MainActor
    func testOverviewMapsContentWithItsRows() {
        let state = overviewState(
            .content,
            refreshing: true,
            areas: [SharedSDK.OverviewAreaItem(id: "a", name: "Work", color: "#5856D6", icon: "briefcase", activeProjectCount: 6)],
            projects: [SharedSDK.OverviewProjectItem(id: "p", name: "Semprec", color: nil, areaName: "Work", status: "inProgress")],
            collections: [
                SharedSDK.OverviewCollectionItem(
                    databaseId: "d", ownerModuleId: "events", name: "Events", icon: nil, color: "#FF3B30", itemCount: 214
                )
            ]
        )
        XCTAssertEqual(
            SharedOverviewScreenModel.state(state),
            .content(
                OverviewContent(
                    refreshing: true,
                    accountEmail: "a@b.cz",
                    inboxPending: 9,
                    mailUnread: 5,
                    tasksToday: 4,
                    problemCount: 2,
                    journalTodayItemId: "j1",
                    areas: [OverviewArea(id: "a", name: "Work", color: "#5856D6", icon: "briefcase", activeProjectCount: 6)],
                    projects: [OverviewProject(id: "p", name: "Semprec", color: nil, areaName: "Work", status: "inProgress")],
                    collections: [
                        OverviewCollection(
                            databaseId: "d", ownerModuleId: "events", name: "Events", icon: nil, color: "#FF3B30", itemCount: 214
                        )
                    ]
                )
            )
        )
    }

    // MARK: - Overview actions and targets
    @MainActor
    func testOverviewMapsEachAction() throws {
        XCTAssertTrue(SharedOverviewScreenModel.action(.retry) is SharedSDK.OverviewActionRetry)
        XCTAssertTrue(SharedOverviewScreenModel.action(.refresh) is SharedSDK.OverviewActionRefresh)
        let open = try XCTUnwrap(SharedOverviewScreenModel.action(.open(.tasks)) as? SharedSDK.OverviewActionOpen)
        XCTAssertTrue(open.target is SharedSDK.OverviewTargetTasks)
    }

    @MainActor
    func testEveryOverviewTargetMapsBothWays() {
        let targets: [CoreKit.OverviewTarget] = [
            .inbox, .mail, .recordings, .tasks, .finance, .profile,
            .journal(itemId: "j1"), .journal(itemId: nil),
            .area(id: "a"), .project(id: "p"), .collection(ownerModuleId: "events", databaseId: "d")
        ]
        for target in targets {
            let shared = SharedOverviewScreenModel.sharedTarget(target)
            XCTAssertEqual(SharedOverviewScreenModel.target(shared), target)
        }
    }

    @MainActor
    func testOverviewMapsEachKotlinTarget() {
        XCTAssertEqual(SharedOverviewScreenModel.target(SharedSDK.OverviewTargetInbox.shared), .inbox)
        XCTAssertEqual(SharedOverviewScreenModel.target(SharedSDK.OverviewTargetMail.shared), .mail)
        XCTAssertEqual(SharedOverviewScreenModel.target(SharedSDK.OverviewTargetRecordings.shared), .recordings)
        XCTAssertEqual(SharedOverviewScreenModel.target(SharedSDK.OverviewTargetFinance.shared), .finance)
        XCTAssertEqual(SharedOverviewScreenModel.target(SharedSDK.OverviewTargetProfile.shared), .profile)
        XCTAssertEqual(
            SharedOverviewScreenModel.target(SharedSDK.OverviewTargetCollection(ownerModuleId: "people", databaseId: "d2")),
            .collection(ownerModuleId: "people", databaseId: "d2")
        )
    }

    // MARK: - Search state
    @MainActor
    func testSearchMapsEveryPhase() {
        XCTAssertEqual(SharedSearchScreenModel.state(searchState(.recents)).phase, .recents)
        XCTAssertEqual(SharedSearchScreenModel.state(searchState(.searching)).phase, .searching)
        XCTAssertEqual(SharedSearchScreenModel.state(searchState(.results)).phase, .results)
        XCTAssertEqual(SharedSearchScreenModel.state(searchState(.empty)).phase, .empty)
        XCTAssertEqual(
            SharedSearchScreenModel.state(searchState(.error, failure: .unavailable)).phase,
            .failure(.unavailable)
        )
        XCTAssertEqual(SharedSearchScreenModel.state(searchState(.error)).phase, .failure(nil))
    }

    @MainActor
    func testSearchMapsTheScopeTheRecentsAndTheGroups() {
        let result = SharedSDK.SearchResultItem(
            key: "th1",
            itemId: "m1",
            threadId: "th1",
            databaseKey: "emails",
            title: "Re: Nabidka",
            subtitle: [SharedSDK.SearchSubtitleItem(kind: .sender, value: "Petr", itemId: nil)],
            snippet: "fragment",
            journalType: "day",
            journalPeriod: "2026-10-16"
        )
        let state = SharedSearchScreenModel.state(
            searchState(
                .results,
                scope: .mail,
                recents: ["faktura"],
                groups: [SharedSDK.SearchGroupItem(type: .mail, total: 7, results: [result])]
            )
        )
        XCTAssertEqual(state.scope, .mail)
        XCTAssertEqual(state.recents, ["faktura"])
        XCTAssertEqual(
            state.groups,
            [
                SearchGroup(
                    type: .mail,
                    total: 7,
                    results: [
                        SearchResult(
                            key: "th1",
                            itemId: "m1",
                            threadId: "th1",
                            databaseKey: "emails",
                            title: "Re: Nabidka",
                            subtitle: [SearchSubtitlePart(kind: .sender, value: "Petr", itemId: nil)],
                            snippet: "fragment",
                            journalType: "day",
                            journalPeriod: "2026-10-16"
                        )
                    ]
                )
            ]
        )
        XCTAssertNil(SharedSearchScreenModel.state(searchState(.recents)).scope)
    }

    @MainActor
    func testEverySearchKindMapsFromKotlin() {
        let groups: [(SharedSDK.SearchGroupType, CoreKit.SearchGroupType)] = [
            (.task, .task), (.event, .event), (.project, .project), (.area, .area), (.contact, .contact),
            (.journal, .journal), (.file, .file), (.mail, .mail), (.chat, .chat)
        ]
        for (shared, native) in groups {
            XCTAssertEqual(CoreKit.SearchGroupType(shared), native)
            XCTAssertEqual(native.shared, shared)
        }
        XCTAssertEqual(groups.count, CoreKit.SearchGroupType.allCases.count)
        let kinds: [(SharedSDK.SearchSubtitleKind, CoreKit.SearchSubtitleKind)] = [
            (.date, .date), (.time, .time), (.timeRange, .timeRange), (.place, .place), (.recurrence, .recurrence),
            (.project, .project), (.area, .area), (.people, .people), (.phone, .phone),
            (.relationship, .relationship), (.status, .status), (.count, .count), (.sender, .sender),
            (.movedFrom, .movedFrom), (.missedInEvent, .missedInEvent)
        ]
        for (shared, native) in kinds {
            XCTAssertEqual(CoreKit.SearchSubtitleKind(shared), native)
        }
    }

    // MARK: - Search actions and effects
    @MainActor
    func testSearchMapsEveryAction() throws {
        let changed = try XCTUnwrap(
            SharedSearchScreenModel.action(.queryChanged("fakt")) as? SharedSDK.SearchActionQueryChanged
        )
        XCTAssertEqual(changed.text, "fakt")
        let scoped = try XCTUnwrap(
            SharedSearchScreenModel.action(.selectScope(.contact)) as? SharedSDK.SearchActionSelectScope
        )
        XCTAssertEqual(scoped.scope, .contact)
        let all = try XCTUnwrap(
            SharedSearchScreenModel.action(.selectScope(nil)) as? SharedSDK.SearchActionSelectScope
        )
        XCTAssertNil(all.scope)
        let submit = try XCTUnwrap(SharedSearchScreenModel.action(.submit("fakt")) as? SharedSDK.SearchActionSubmit)
        XCTAssertEqual(submit.text, "fakt")
        XCTAssertTrue(SharedSearchScreenModel.action(.retry) is SharedSDK.SearchActionRetry)
        let open = try XCTUnwrap(
            SharedSearchScreenModel.action(.open(type: .task, key: "t1")) as? SharedSDK.SearchActionOpen
        )
        XCTAssertEqual(open.type, .task)
        XCTAssertEqual(open.key, "t1")
    }

    @MainActor
    func testSearchMapsTheOpenedResultEffect() {
        let effect = SharedSDK.SearchEffectOpenResult(
            type: .journal,
            itemId: "j1",
            threadId: nil,
            databaseKey: "journal",
            journalType: "day",
            journalPeriod: "2026-10-16"
        )
        XCTAssertEqual(
            SharedSearchScreenModel.effect(effect),
            .openResult(
                type: .journal,
                itemId: "j1",
                threadId: nil,
                databaseKey: "journal",
                journalType: "day",
                journalPeriod: "2026-10-16"
            )
        )
    }

    // MARK: - Builders
    private func overviewState(
        _ phase: SharedSDK.OverviewPhase,
        failure: SharedSDK.FailureKind? = nil,
        refreshing: Bool = false,
        areas: [SharedSDK.OverviewAreaItem] = [],
        projects: [SharedSDK.OverviewProjectItem] = [],
        collections: [SharedSDK.OverviewCollectionItem] = []
    ) -> SharedSDK.OverviewState {
        SharedSDK.OverviewState(
            phase: phase,
            failure: failure,
            refreshing: refreshing,
            accountEmail: "a@b.cz",
            inboxPending: 9,
            mailUnread: 5,
            tasksToday: 4,
            problemCount: 2,
            journalTodayItemId: "j1",
            areas: areas,
            projects: projects,
            collections: collections
        )
    }

    private func searchState(
        _ phase: SharedSDK.SearchPhase,
        failure: SharedSDK.FailureKind? = nil,
        scope: SharedSDK.SearchGroupType? = nil,
        recents: [String] = [],
        groups: [SharedSDK.SearchGroupItem] = []
    ) -> SharedSDK.SearchState {
        SharedSDK.SearchState(phase: phase, failure: failure, scope: scope, recents: recents, groups: groups)
    }
}
