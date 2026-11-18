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

/// Every branch of the Semp bridges' state mappings, over Kotlin values built here.
@MainActor
final class SharedSempValueMappingTests: XCTestCase {

    func testProjectAgentActionsMapEverySectionAndAnswer() {
        for (section, expected) in [
            (SempSection.purpose, SharedSDK.SempSection.purpose),
            (.allowed, .allowed),
            (.notAllowed, .notAllowed),
            (.general, .general)
        ] {
            let save = SharedSempProjectAgentScreenModel.action(.saveSection(section, text: "t"))
                as? SharedSDK.SempProjectAgentActionSaveSection
            XCTAssertEqual(save?.section, expected)
            XCTAssertEqual(save?.text, "t")
        }
        for (answer, expected) in [
            (SempDriftAnswer.allow, SharedSDK.SempDriftAnswer.allow),
            (.forbid, .forbid),
            (.dismiss, .dismiss)
        ] {
            let resolve = SharedSempProjectAgentScreenModel.action(.resolveDrift(answer))
                as? SharedSDK.SempProjectAgentActionResolveDrift
            XCTAssertEqual(resolve?.answer, expected)
        }
        XCTAssertTrue(SharedSempProjectAgentScreenModel.action(.retry) is SharedSDK.SempProjectAgentActionRetry)
        XCTAssertTrue(SharedSempProjectAgentScreenModel.action(.retrySave) is SharedSDK.SempProjectAgentActionRetrySave)
        XCTAssertTrue(
            SharedSempProjectAgentScreenModel.action(.dismissFailure) is SharedSDK.SempProjectAgentActionDismissFailure
        )
        let tool = SharedSempProjectAgentScreenModel.action(.setTool(registrationId: "g", granted: true))
            as? SharedSDK.SempProjectAgentActionSetTool
        XCTAssertEqual(tool?.registrationId, "g")
        XCTAssertEqual(tool?.granted, true)
        let task = SharedSempProjectAgentScreenModel.action(.setTask(taskId: "t", enabled: false))
            as? SharedSDK.SempProjectAgentActionSetTask
        XCTAssertEqual(task?.enabled, false)
        let openTask = SharedSempProjectAgentScreenModel.action(.openTask(taskId: "t"))
            as? SharedSDK.SempProjectAgentActionOpenTask
        XCTAssertEqual(openTask?.taskId, "t")
        let openRun = SharedSempProjectAgentScreenModel.action(.openRun(rowId: "r"))
            as? SharedSDK.SempProjectAgentActionOpenRun
        XCTAssertEqual(openRun?.rowId, "r")
    }

    // MARK: - States
    func testTheBubbleStateMapsTheBadgeTheAttachmentsAndEveryToast() {
        let toasts: [(SharedSDK.SempBubbleToast?, SempBubbleToast?)] = [
            (nil, nil), (.added, .added), (.alreadyAdded, .alreadyAdded), (.cannotAdd, .cannotAdd),
            (.newThread, .newThread), (.continueThread, .continueThread)
        ]
        for (kotlin, swift) in toasts {
            let state = SharedSempBubbleScreenModel.state(
                SharedSDK.SempBubbleState(badge: 3, attachments: 2, toast: kotlin)
            )
            XCTAssertEqual(state, SempBubbleState(badge: 3, attachments: 2, toast: swift))
        }
    }

    func testPhasesMapToLoadingReadyAndFailureWithItsReason() {
        XCTAssertEqual(SempPhase(SharedSDK.SempChatsPhase.loading, failure: nil), .loading)
        XCTAssertEqual(SempPhase(SharedSDK.SempChatsPhase.ready, failure: nil), .ready)
        XCTAssertEqual(SempPhase(SharedSDK.SempChatsPhase.error, failure: .notFound), .failure(.notFound))
        XCTAssertEqual(SempPhase(SharedSDK.SempThreadPhase.error, failure: nil), .failure(nil))
        XCTAssertEqual(SempPhase(SharedSDK.SempStatusPhase.error, failure: .rejected), .failure(.rejected))
        XCTAssertEqual(SempPhase(SharedSDK.SempRunPhase.ready, failure: nil), .ready)
        XCTAssertEqual(SempPhase(SharedSDK.SempApprovalsPhase.loading, failure: nil), .loading)
        XCTAssertEqual(SempPhase(SharedSDK.SempAgentPhase.error, failure: .unavailable), .failure(.unavailable))
    }

    func testAnApprovalMapsItsDescriptionRiskOriginAndDecision() {
        let item = SharedSDK.SempApprovalItem(
            id: "a1",
            descriptionKey: "approval.itemDelete",
            descriptionParams: ["itemName": "Tax return"],
            callLabel: "item.delete",
            argumentKeys: ["itemId"],
            risk: .irreversible,
            origin: .tick,
            threadId: "t1",
            threadTitle: "Plan",
            heartbeatName: "Weekly",
            projectName: "Finance",
            requestedAt: "2026-10-21T13:24:00.000Z",
            runId: "r1",
            breaksLink: true,
            decision: .conflict,
            conflictKey: "approval.conflict.deleted",
            decisionFailed: true,
            decisionFailure: .unavailable
        )
        let mapped = SempApprovalItem(item)
        XCTAssertEqual(mapped.descriptionKey, "approval.itemDelete")
        XCTAssertEqual(mapped.descriptionParams, ["itemName": "Tax return"])
        XCTAssertEqual(mapped.risk, .irreversible)
        XCTAssertEqual(mapped.origin, .tick)
        XCTAssertEqual(mapped.decision, .conflict)
        XCTAssertEqual(mapped.conflictKey, "approval.conflict.deleted")
        XCTAssertTrue(mapped.decisionFailed)
        XCTAssertEqual(mapped.decisionFailure, .unavailable)
        XCTAssertEqual(mapped.heartbeatName, "Weekly")
        XCTAssertTrue(mapped.breaksLink)
    }

    func testEveryApprovalEnumMaps() {
        XCTAssertEqual(
            [SharedSDK.SempRisk.irreversible, .outbound, .breaksLink, .write].map(SempRisk.init),
            [.irreversible, .outbound, .breaksLink, .write]
        )
        XCTAssertEqual([SharedSDK.SempOrigin.chat, .tick, .mcp].map(SempOrigin.init), [.chat, .tick, .mcp])
        XCTAssertEqual(
            [SharedSDK.SempDecisionState.pending, .approving, .rejecting, .queued, .executed, .rejected, .conflict]
                .map(SempDecisionState.init),
            [.pending, .approving, .rejecting, .queued, .executed, .rejected, .conflict]
        )
    }

    func testRunValuesMap() {
        XCTAssertEqual(
            [SharedSDK.SempRunDisplay.running, .done, .waitingApproval, .error].map(SempRunDisplay.init),
            [.running, .done, .waitingApproval, .error]
        )
        XCTAssertEqual(
            [SharedSDK.SempRunTriggerKind.user, .tick, .mcp, .supervisor].map(SempRunTriggerKind.init),
            [.user, .tick, .mcp, .supervisor]
        )
        XCTAssertEqual(
            [SharedSDK.SempRunStepKindView.start, .plan, .tool, .approval, .answer, .end, .error]
                .map(SempRunStepKind.init),
            [.start, .plan, .tool, .approval, .answer, .end, .error]
        )
        XCTAssertEqual(
            [SharedSDK.SempLineState.running, .ok, .error, .waitingApproval].map(SempLineState.init),
            [.running, .ok, .error, .waitingApproval]
        )
        XCTAssertEqual(
            [SharedSDK.SempStepsPhase.none, .loading, .ready, .error].map(SempStepsPhase.init),
            [.none, .loading, .ready, .error]
        )
    }

    func testThreadValuesMap() {
        XCTAssertEqual([SharedSDK.SempThreadType.chat, .item, .tick].map(SempThreadType.init), [.chat, .item, .tick])
        XCTAssertEqual(
            [SharedSDK.SempEntryRole.user, .assistant, .system].map(SempEntryRole.init),
            [.user, .assistant, .system]
        )
        XCTAssertEqual([SharedSDK.SempDelivery.sending, .failed].map(SempDelivery.init), [.sending, .failed])
        XCTAssertEqual(
            [SharedSDK.SempReplyPhase.thinking, .working, .done, .failed].map(SempReplyPhase.init),
            [.thinking, .working, .done, .failed]
        )
        XCTAssertEqual(
            [SharedSDK.SempChangeType.created, .updated, .deleted, .restored, .revised].map(SempChangeType.init),
            [.created, .updated, .deleted, .restored, .revised]
        )
        XCTAssertEqual(
            [SharedSDK.SempRunChipState.ok, .waitingApproval, .failed].map(SempRunChipState.init),
            [.ok, .waitingApproval, .failed]
        )
        XCTAssertEqual(
            [SharedSDK.SempSaveState.idle, .saving, .saved, .failed, .conflict].map(SempSaveState.init),
            [.idle, .saving, .saved, .failed, .conflict]
        )
        XCTAssertEqual(
            [SharedSDK.SempIssueFix.retry, .disableAutomation].map(SempIssueFix.init),
            [.retry, .disableAutomation]
        )
        XCTAssertEqual(
            [SharedSDK.SempIssueLink.chat, .thread, .project, .mailbox].map(SempIssueLink.init),
            [.chat, .thread, .project, .mailbox]
        )
        XCTAssertEqual(
            SharedSempStatusScreenModel.effect(SharedSDK.SempStatusEffectOpenMailbox(mailboxId: "mb")),
            .openMailbox(mailboxId: "mb")
        )
        XCTAssertEqual(
            [SharedSDK.SempChatsFilter.all, .chats, .ticks].map(SempChatsFilter.init),
            [.all, .chats, .ticks]
        )
        XCTAssertEqual([SempChatsFilter.all, .chats, .ticks].map(\.shared), [.all, .chats, .ticks])
        XCTAssertEqual([SharedSDK.SempApprovalsTab.pending, .decided].map(SempApprovalsTab.init), [.pending, .decided])
    }
}
