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

/// The real Kotlin Semp ViewModels driven through the bridges. The test host has no signed-in session, so every read
/// ends in an unauthorized failure without a request, which is enough to show the bridges deliver state and effects
/// and close their ViewModels.
@MainActor
final class SharedSempScreenModelTests: XCTestCase {

    // MARK: - Real view models
    func testEveryScreenWithoutASessionEndsUnauthorized() async throws {
        let factory = SharedScreenModelFactory()
        let thread = factory.makeSempThread(start: .existing, threadId: "t1", inboxItemId: nil, title: nil, meta: nil)
        let chats = factory.makeSempChats()
        let status = factory.makeSempStatus()
        let run = factory.makeSempRun(runId: "r1", messageId: nil)
        let approvals = factory.makeSempApprovals()
        let agent = factory.makeSempProjectAgent(projectId: "p1")
        let failed = SempPhase.failure(.unauthorized)
        let results = [
            await wait(thread) { $0.phase == failed },
            await wait(chats) { $0.phase == failed },
            await wait(status) { $0.phase == failed },
            await wait(run) { $0.phase == failed },
            await wait(approvals) { $0.phase == failed },
            await wait(agent) { $0.phase == failed }
        ]
        XCTAssertEqual(results, [true, true, true, true, true, true])
    }

    func testAnObjectDroppedOnTheBubbleIsStagedAndShownByTheThreadOfTheSameWindow() async {
        let factory = SharedScreenModelFactory()
        let bubble = factory.makeSempBubble()
        let thread = factory.makeSempThread(start: .new, threadId: nil, inboxItemId: nil, title: nil, meta: nil)

        bubble.send(.drop(SempTarget(kind: .task, title: "Send invoice", itemId: "i1", databaseId: "d1")))

        let staged = await wait(thread) { $0.attachments.map(\.title) == ["Send invoice"] }
        XCTAssertTrue(staged)
        let toast = await wait(bubble) { $0.toast == .added && $0.attachments == 1 }
        XCTAssertTrue(toast)
        let other = SharedScreenModelFactory().makeSempThread(
            start: .new,
            threadId: nil,
            inboxItemId: nil,
            title: nil,
            meta: nil
        )
        XCTAssertEqual(other.state.attachments, [], "Another window does not see what this window staged")
    }

    func testDroppingAnInboxItemRaisesTheEffectToOpenItsThread() async {
        let bubble = SharedScreenModelFactory().makeSempBubble()
        bubble.send(.drop(SempTarget(kind: .inbox, title: "Call", meta: "today", itemId: "inbox-1")))

        var received: [SempBubbleEffect] = []
        for await effect in bubble.effects() {
            received.append(effect)
            break
        }

        XCTAssertEqual(received, [.openItemThread(inboxItemId: "inbox-1", title: "Call", meta: "today")])
    }

    func testEffectsOfAThreadAreDeliveredOnceInOrder() async {
        let thread = SharedScreenModelFactory()
            .makeSempThread(start: .new, threadId: nil, inboxItemId: nil, title: nil, meta: nil)
        thread.send(.open(.history))
        thread.send(.open(.run(runId: "r", messageId: "m")))
        thread.send(.open(.newChat))

        var received: [SempThreadEffect] = []
        for await effect in thread.effects() {
            received.append(effect)
            if received.count == 3 { break }
        }

        XCTAssertEqual(received, [.openHistory, .openRun(runId: "r", messageId: "m"), .openNewChat])
    }

    func testReleasingABridgeClosesItsKotlinViewModel() throws {
        var model: SharedSempThreadScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory()
                .makeSempThread(start: .new, threadId: nil, inboxItemId: nil, title: nil, meta: nil)
                as? SharedSempThreadScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }

    // MARK: - Waiting
    private func wait<Model: ScreenModel>(
        _ model: Model,
        timeout: TimeInterval = 5,
        until condition: @escaping @MainActor (Model.State) -> Bool
    ) async -> Bool {
        if condition(model.state) { return true }
        let reading = Task { @MainActor in
            for await state in model.states() where condition(state) { return true }
            return false
        }
        let timer = Task {
            try? await Task.sleep(for: .seconds(timeout))
            reading.cancel()
        }
        let found = await reading.value
        timer.cancel()
        return found
    }
}
