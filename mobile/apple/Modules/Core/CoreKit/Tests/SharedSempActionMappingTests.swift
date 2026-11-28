import SharedSDK
import XCTest

@testable import CoreKit

private typealias SempSection = CoreKit.SempSection
private typealias SempDriftAnswer = CoreKit.SempDriftAnswer
private typealias SempTargetKind = CoreKit.SempTargetKind
private typealias SempTarget = CoreKit.SempTarget
private typealias SempBubbleToast = CoreKit.SempBubbleToast
private typealias SempBubbleEffect = CoreKit.SempBubbleEffect
private typealias SempThreadEffect = CoreKit.SempThreadEffect
private typealias SempThreadStart = CoreKit.SempThreadStart
private typealias SempRisk = CoreKit.SempRisk
private typealias SempOrigin = CoreKit.SempOrigin
private typealias SempDecisionState = CoreKit.SempDecisionState
private typealias SempRunDisplay = CoreKit.SempRunDisplay
private typealias SempRunTriggerKind = CoreKit.SempRunTriggerKind
private typealias SempRunStepKind = CoreKit.SempRunStepKind
private typealias SempLineState = CoreKit.SempLineState
private typealias SempStepsPhase = CoreKit.SempStepsPhase
private typealias SempThreadType = CoreKit.SempThreadType
private typealias SempEntryRole = CoreKit.SempEntryRole
private typealias SempDelivery = CoreKit.SempDelivery
private typealias SempReplyPhase = CoreKit.SempReplyPhase
private typealias SempChangeType = CoreKit.SempChangeType
private typealias SempRunChipState = CoreKit.SempRunChipState
private typealias SempSaveState = CoreKit.SempSaveState
private typealias SempIssueFix = CoreKit.SempIssueFix
private typealias SempIssueLink = CoreKit.SempIssueLink
private typealias SempChatsFilter = CoreKit.SempChatsFilter
private typealias SempApprovalsTab = CoreKit.SempApprovalsTab
private typealias SempApprovalItem = CoreKit.SempApprovalItem
private typealias SempBubbleState = CoreKit.SempBubbleState
private typealias SempThreadAction = CoreKit.SempThreadAction
private typealias SempChatsAction = CoreKit.SempChatsAction
private typealias SempApprovalsAction = CoreKit.SempApprovalsAction
private typealias SempStatusAction = CoreKit.SempStatusAction
private typealias SempRunAction = CoreKit.SempRunAction
private typealias SempProjectAgentAction = CoreKit.SempProjectAgentAction
private typealias SempBubbleAction = CoreKit.SempBubbleAction

/// Every Semp action reaches its Kotlin action with its arguments.
@MainActor
final class SharedSempActionMappingTests: XCTestCase {

    // MARK: - Actions
    func testThreadActionsMapToTheirKotlinActions() {
        XCTAssertTrue(SharedSempThreadScreenModel.action(.retry) is SharedSDK.SempThreadActionRetry)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.refresh) is SharedSDK.SempThreadActionRefresh)
        let send = SharedSempThreadScreenModel.action(.send("Hi")) as? SharedSDK.SempThreadActionSend
        XCTAssertEqual(send?.text, "Hi")
        let unsent = SharedSempThreadScreenModel.action(.resolveUnsent(id: "l1", retry: true))
            as? SharedSDK.SempThreadActionResolveUnsent
        XCTAssertEqual(unsent?.id, "l1")
        XCTAssertEqual(unsent?.retry, true)
        let again = SharedSempThreadScreenModel.action(.askAgain(messageId: "m", regenerate: true))
            as? SharedSDK.SempThreadActionAskAgain
        XCTAssertEqual(again?.messageId, "m")
        XCTAssertEqual(again?.regenerate, true)
        XCTAssertEqual(
            (SharedSempThreadScreenModel.action(.toggleRun(messageId: "m")) as? SharedSDK.SempThreadActionToggleRun)?
                .messageId,
            "m"
        )
        let decide = SharedSempThreadScreenModel.action(.decide(approvalId: "a", approve: false))
            as? SharedSDK.SempThreadActionDecide
        XCTAssertEqual(decide?.approvalId, "a")
        XCTAssertEqual(decide?.approve, false)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.loadOlder) is SharedSDK.SempThreadActionLoadOlder)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.runAgain) is SharedSDK.SempThreadActionRunAgain)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.dismiss(.notice)) is SharedSDK.SempThreadActionDismissNotice)
        let dismissFailure = SharedSempThreadScreenModel.action(.dismiss(.failure))
        XCTAssertTrue(dismissFailure is SharedSDK.SempThreadActionDismissFailure)
        XCTAssertEqual(
            (SharedSempThreadScreenModel.action(.dismiss(.attachment(key: "k")))
                as? SharedSDK.SempThreadActionDismissAttachment)?.key,
            "k"
        )
        let run = SharedSempThreadScreenModel.action(.open(.run(runId: "r", messageId: nil)))
            as? SharedSDK.SempThreadActionOpenRun
        XCTAssertEqual(run?.runId, "r")
        XCTAssertNil(run?.messageId)
        let change = SharedSempThreadScreenModel.action(.open(.change(itemId: "i", databaseKey: "tasks")))
            as? SharedSDK.SempThreadActionOpenChange
        XCTAssertEqual(change?.databaseKey, "tasks")
        XCTAssertTrue(SharedSempThreadScreenModel.action(.open(.approvals)) is SharedSDK.SempThreadActionOpenApprovals)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.open(.status)) is SharedSDK.SempThreadActionOpenStatus)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.open(.history)) is SharedSDK.SempThreadActionOpenHistory)
        XCTAssertTrue(SharedSempThreadScreenModel.action(.open(.newChat)) is SharedSDK.SempThreadActionOpenNewChat)
    }

    func testTheOtherActionsMapToTheirKotlinActions() {
        XCTAssertEqual(
            (SharedSempChatsScreenModel.action(.setFilter(.ticks)) as? SharedSDK.SempChatsActionSetFilter)?.filter,
            .ticks
        )
        XCTAssertEqual(
            (SharedSempChatsScreenModel.action(.setQuery("faktura")) as? SharedSDK.SempChatsActionSetQuery)?.text,
            "faktura"
        )
        XCTAssertTrue(SharedSempChatsScreenModel.action(.loadMore) is SharedSDK.SempChatsActionLoadMore)
        XCTAssertTrue(SharedSempChatsScreenModel.action(.retry) is SharedSDK.SempChatsActionRetry)
        XCTAssertEqual(
            (SharedSempChatsScreenModel.action(.openThread(threadId: "t")) as? SharedSDK.SempChatsActionOpenThread)?
                .threadId,
            "t"
        )
        XCTAssertTrue(SharedSempChatsScreenModel.action(.openApprovals) is SharedSDK.SempChatsActionOpenApprovals)
        XCTAssertTrue(SharedSempChatsScreenModel.action(.openNewChat) is SharedSDK.SempChatsActionOpenNewChat)
        XCTAssertEqual(
            (SharedSempChatsScreenModel.action(.decide(approvalId: "a", approve: true))
                as? SharedSDK.SempChatsActionDecide)?.approve,
            true
        )
        XCTAssertEqual(
            (SharedSempApprovalsScreenModel.action(.setTab(.decided)) as? SharedSDK.SempApprovalsActionSetTab)?.tab,
            .decided
        )
        XCTAssertTrue(SharedSempApprovalsScreenModel.action(.retry) is SharedSDK.SempApprovalsActionRetry)
        XCTAssertTrue(SharedSempApprovalsScreenModel.action(.loadMore) is SharedSDK.SempApprovalsActionLoadMore)
        XCTAssertEqual(
            (SharedSempApprovalsScreenModel.action(.toggleDetails(approvalId: "a"))
                as? SharedSDK.SempApprovalsActionToggleDetails)?.approvalId,
            "a"
        )
        XCTAssertEqual(
            (SharedSempApprovalsScreenModel.action(.openThread(approvalId: "a"))
                as? SharedSDK.SempApprovalsActionOpenThread)?.approvalId,
            "a"
        )
        XCTAssertEqual(
            (SharedSempApprovalsScreenModel.action(.openRun(approvalId: "a")) as? SharedSDK.SempApprovalsActionOpenRun)?
                .approvalId,
            "a"
        )
        XCTAssertEqual(
            (SharedSempApprovalsScreenModel.action(.decide(approvalId: "a", approve: false))
                as? SharedSDK.SempApprovalsActionDecide)?.approve,
            false
        )
    }

    func testStatusRunAndBubbleActionsMapToTheirKotlinActions() {
        XCTAssertTrue(SharedSempStatusScreenModel.action(.retry) is SharedSDK.SempStatusActionRetry)
        XCTAssertEqual(
            (SharedSempStatusScreenModel.action(.fix(issueId: "p")) as? SharedSDK.SempStatusActionFix)?.issueId,
            "p"
        )
        XCTAssertEqual(
            (SharedSempStatusScreenModel.action(.open(issueId: "p")) as? SharedSDK.SempStatusActionOpen)?.issueId,
            "p"
        )
        XCTAssertTrue(SharedSempStatusScreenModel.action(.toggleHistory) is SharedSDK.SempStatusActionToggleHistory)
        XCTAssertTrue(SharedSempRunScreenModel.action(.retry) is SharedSDK.SempRunActionRetry)
        XCTAssertTrue(SharedSempRunScreenModel.action(.retryRun) is SharedSDK.SempRunActionRetryRun)
        XCTAssertTrue(SharedSempRunScreenModel.action(.openThread) is SharedSDK.SempRunActionOpenThread)
        XCTAssertTrue(SharedSempRunScreenModel.action(.openApprovals) is SharedSDK.SempRunActionOpenApprovals)
        XCTAssertTrue(SharedSempBubbleScreenModel.action(.refresh) is SharedSDK.SempBubbleActionRefresh)
    }

    func testDroppingAnObjectOnTheBubbleMapsEveryField() {
        let target = SempTarget(
            kind: .task,
            title: "Send invoice",
            meta: "today",
            itemId: "i1",
            databaseId: "d1",
            mailThreadId: "m1",
            runId: "r1"
        )
        let drop = SharedSempBubbleScreenModel.action(.drop(target)) as? SharedSDK.SempBubbleActionDrop
        XCTAssertEqual(drop?.target.kind, .task)
        XCTAssertEqual(drop?.target.title, "Send invoice")
        XCTAssertEqual(drop?.target.meta, "today")
        XCTAssertEqual(drop?.target.itemId, "i1")
        XCTAssertEqual(drop?.target.databaseId, "d1")
        XCTAssertEqual(drop?.target.mailThreadId, "m1")
        XCTAssertEqual(drop?.target.runId, "r1")
    }

    func testEveryTargetKindRoundTrips() {
        let kinds: [SempTargetKind] = [
            .task, .event, .mail, .inbox, .journal, .project, .person, .company, .file, .note, .recording,
            .finance, .health, .recipe, .book, .movie, .run, .other
        ]
        for kind in kinds { XCTAssertEqual(SempTargetKind(kind.shared), kind) }
        XCTAssertEqual(Set(kinds.map { "\($0.shared)" }).count, kinds.count)
    }

    func testEveryThreadStartMapsToItsKotlinCase() {
        XCTAssertEqual(SempThreadStart.latest.shared, .latest)
        XCTAssertEqual(SempThreadStart.new.shared, .theNew)
        XCTAssertEqual(SempThreadStart.existing.shared, .existing)
        XCTAssertEqual(SempThreadStart.item.shared, .item)
    }
}
