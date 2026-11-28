import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the mail bridges' mappings between Kotlin and Swift values with Kotlin values built here.
/// Both modules declare most of these type names, so each is qualified with its module.
final class MailMappingTests: XCTestCase {

    // MARK: - Thread list state
    @MainActor
    func testThreadsMapLoadingAndFailure() {
        XCTAssertEqual(SharedMailThreadsScreenModel.state(threadsState(.loading)).phase, .loading)
        XCTAssertEqual(
            SharedMailThreadsScreenModel.state(threadsState(.error, failure: .unauthorized)).phase,
            .failure(.unauthorized)
        )
        XCTAssertEqual(SharedMailThreadsScreenModel.state(threadsState(.error)).phase, .failure(nil))
    }

    @MainActor
    func testThreadsMapContentWithItsRowsFiltersAndFacets() {
        let row = SharedSDK.MailThreadItem(
            threadId: "t1", subject: "Re", lastMessageAt: "2026-10-20T12:41:00.000000Z", senderName: "Petr",
            senderAddress: "p@x.cz", senderRelationship: "Klient", messageCount: 4, preview: "Díky",
            hasAttachment: true, unread: true, flagged: true, mailboxNames: ["Gmail"], projectName: "Web",
            companyName: "Novák", hasSempDraft: true
        )
        let facets = SharedSDK.MailFacetsState(
            phase: .ready,
            projectTotal: 7,
            projects: [SharedSDK.MailFilterOption(id: "p1", name: "Web", color: "#FF9500", count: 3)]
        )
        let state = SharedMailThreadsScreenModel.state(
            threadsState(
                .content, refreshing: true, hasMore: true, threads: [row], box: .sempDrafts, filter: .flagged,
                facets: facets
            )
        )
        XCTAssertEqual(state.phase, .content)
        XCTAssertTrue(state.refreshing && state.hasMore && state.actionFailed)
        XCTAssertEqual(state.box, .sempDrafts)
        XCTAssertEqual(state.filter, .flagged)
        XCTAssertEqual(state.mailboxId, "m1")
        XCTAssertEqual(state.projectId, "p1")
        XCTAssertEqual(state.projectName, "Web")
        XCTAssertEqual(state.mailboxes, [CoreKit.MailMailboxChip(id: "m1", name: "Gmail")])
        let notice = CoreKit.MailAccountNotice(id: "m2", name: "Outlook", since: "2026-10-19T09:12:00Z")
        XCTAssertEqual(state.reauthorization, [notice])
        XCTAssertEqual(
            state.threads,
            [
                CoreKit.MailThreadItem(
                    threadId: "t1", subject: "Re", lastMessageAt: "2026-10-20T12:41:00.000000Z", senderName: "Petr",
                    senderAddress: "p@x.cz", senderRelationship: "Klient", messageCount: 4, preview: "Díky",
                    hasAttachment: true, unread: true, flagged: true, mailboxNames: ["Gmail"], projectName: "Web",
                    companyName: "Novák", hasSempDraft: true
                )
            ]
        )
        XCTAssertEqual(
            state.facets,
            CoreKit.MailFacetsState(
                phase: .ready,
                projectTotal: 7,
                projects: [CoreKit.MailFilterOption(id: "p1", name: "Web", color: "#FF9500", count: 3)]
            )
        )
    }

    @MainActor
    func testThreadsMapWhatTheProviderSearchAddedAndNoSummaryOutsideASearch() {
        let summary = SharedSDK.MailRemoteSearchSummary(
            unindexed: 12,
            failedAccounts: [
                SharedSDK.MailMailboxChip(id: "m1", name: "Gmail"), SharedSDK.MailMailboxChip(id: "m9", name: "")
            ]
        )
        let searched = SharedMailThreadsScreenModel.state(threadsState(.content, remoteSearch: summary))
        XCTAssertEqual(
            searched.remoteSearch,
            CoreKit.MailRemoteSearchSummary(
                unindexed: 12,
                failedAccounts: [
                    CoreKit.MailMailboxChip(id: "m1", name: "Gmail"), CoreKit.MailMailboxChip(id: "m9", name: "")
                ]
            )
        )
        XCTAssertNil(SharedMailThreadsScreenModel.state(threadsState(.content)).remoteSearch)
    }

    @MainActor
    func testThreadsMapEveryBoxFilterAndFacetsPhase() {
        let boxes: [(SharedSDK.MailListBox, CoreKit.MailListBox)] = [
            (.inbox, .inbox), (.flagged, .flagged), (.sempDrafts, .sempDrafts)
        ]
        for (kotlin, swift) in boxes {
            XCTAssertEqual(SharedMailThreadsScreenModel.state(threadsState(.content, box: kotlin)).box, swift)
            XCTAssertEqual(MailListBox(kotlin), swift)
            XCTAssertEqual(swift.shared, kotlin)
        }
        let filters: [(SharedSDK.MailListFilter, CoreKit.MailListFilter)] = [
            (.all, .all), (.unread, .unread), (.flagged, .flagged)
        ]
        for (kotlin, swift) in filters {
            XCTAssertEqual(SharedMailThreadsScreenModel.state(threadsState(.content, filter: kotlin)).filter, swift)
        }
        let phases: [(SharedSDK.MailFacetsPhase, CoreKit.MailFacetsPhase)] = [
            (.idle, .idle), (.loading, .loading), (.ready, .ready), (.error, .error)
        ]
        for (kotlin, swift) in phases {
            let facets = SharedSDK.MailFacetsState(phase: kotlin, projectTotal: 0, projects: [])
            let state = SharedMailThreadsScreenModel.state(threadsState(.content, facets: facets))
            XCTAssertEqual(state.facets.phase, swift)
        }
    }

    @MainActor
    func testThreadsMapEachActionAndEffect() throws {
        XCTAssertTrue(SharedMailThreadsScreenModel.action(.retry) is SharedSDK.MailThreadsActionRetry)
        XCTAssertTrue(SharedMailThreadsScreenModel.action(.refresh) is SharedSDK.MailThreadsActionRefresh)
        XCTAssertTrue(SharedMailThreadsScreenModel.action(.loadMore) is SharedSDK.MailThreadsActionLoadMore)
        XCTAssertTrue(SharedMailThreadsScreenModel.action(.clearContext) is SharedSDK.MailThreadsActionClearContext)
        XCTAssertTrue(SharedMailThreadsScreenModel.action(.dismissFailure) is SharedSDK.MailThreadsActionDismissFailure)
        let search = try XCTUnwrap(
            SharedMailThreadsScreenModel.action(.search("from:petr")) as? SharedSDK.MailThreadsActionSearch
        )
        XCTAssertEqual(search.text, "from:petr")
        let pairs: [(CoreKit.MailListFilter, SharedSDK.MailListFilter)] = [
            (.all, .all), (.unread, .unread), (.flagged, .flagged)
        ]
        for (filter, kotlin) in pairs {
            let action = try XCTUnwrap(
                SharedMailThreadsScreenModel.action(.selectFilter(filter)) as? SharedSDK.MailThreadsActionSelectFilter
            )
            XCTAssertEqual(action.filter, kotlin)
        }
        let mailbox = try XCTUnwrap(
            SharedMailThreadsScreenModel.action(.selectMailbox("m1")) as? SharedSDK.MailThreadsActionSelectMailbox
        )
        XCTAssertEqual(mailbox.mailboxId, "m1")
        let project = try XCTUnwrap(
            SharedMailThreadsScreenModel.action(.setProject("p1")) as? SharedSDK.MailThreadsActionSetProject
        )
        XCTAssertEqual(project.projectId, "p1")
        let none = try XCTUnwrap(
            SharedMailThreadsScreenModel.action(.setProject(nil)) as? SharedSDK.MailThreadsActionSetProject
        )
        XCTAssertNil(none.projectId)
        let read = try XCTUnwrap(
            SharedMailThreadsScreenModel.action(.toggleRead(threadId: "t1")) as? SharedSDK.MailThreadsActionToggleRead
        )
        XCTAssertEqual(read.threadId, "t1")
    }

    @MainActor
    func testThreadsEffectsAndOpenTargetsMapBothWays() throws {
        let effects: [CoreKit.MailThreadsEffect] = [
            .openThread(threadId: "t1"), .openFolders, .compose, .openAccount(mailboxId: "m1")
        ]
        for effect in effects {
            let shared = SharedMailThreadsScreenModel.sharedEffect(effect)
            XCTAssertEqual(SharedMailThreadsScreenModel.effect(shared), effect)
            let open = try XCTUnwrap(
                SharedMailThreadsScreenModel.action(.open(effect)) as? SharedSDK.MailThreadsActionOpen
            )
            XCTAssertEqual(SharedMailThreadsScreenModel.effect(open.target), effect)
        }
    }
}
