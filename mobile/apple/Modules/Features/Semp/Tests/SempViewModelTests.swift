import CoreKit
import XCTest

@testable import SempFeature

/// A router that records what the screens asked for.
@MainActor
final class SempRouterSpy: SempRouting {

    enum Call: Equatable {
        case history
        case newChat
        case thread(String, SempThreadType, String?)
        case chat(String, String)
        case run(String, String?)
        case approvals
        case status
        case item(String, String?)
        case project(String)
        case itemThread(String, String, String?)
    }

    private(set) var calls: [Call] = []

    func showHistory() { calls.append(.history) }
    func showNewChat() { calls.append(.newChat) }
    func showThread(threadId: String, type: SempThreadType, title: String?) {
        calls.append(.thread(threadId, type, title))
    }
    func showChat(threadId: String, messageId: String) { calls.append(.chat(threadId, messageId)) }
    func showRun(runId: String, messageId: String?) { calls.append(.run(runId, messageId)) }
    func showApprovals() { calls.append(.approvals) }
    func showStatus() { calls.append(.status) }
    func showItem(itemId: String, databaseKey: String?) { calls.append(.item(itemId, databaseKey)) }
    func showProject(projectId: String) { calls.append(.project(projectId)) }
    func showItemThread(inboxItemId: String, title: String, meta: String?) {
        calls.append(.itemThread(inboxItemId, title, meta))
    }
}

/// The feature ViewModels republish their model's state, forward intents and route effects, and release their model.
final class SempViewModelTests: XCTestCase {

    // MARK: - Thread
    @MainActor
    func testTheThreadStartsFromTheModelsStateAndRepublishesChanges() async throws {
        let model = ScriptedSempThreadScreenModel(state: SempThreadState(phase: .loading))
        let viewModel = SempThreadViewModel(model: model, router: SempRouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }

        model.publish(SempThreadState(phase: .ready, entries: [SempEntry(id: "u1", role: .user, text: "Hi")]))
        try await eventually { viewModel.state.entries.count == 1 }
        model.publish(SempThreadState(phase: .failure(.unavailable)))
        try await eventually { viewModel.state.phase == .failure(.unavailable) }
        observer.cancel()
    }

    @MainActor
    func testEveryThreadEffectIsRoutedAndEveryIntentForwarded() async throws {
        let model = ScriptedSempThreadScreenModel(
            state: SempThreadState(phase: .ready),
            effects: [
                .openRun(runId: "r", messageId: "m"),
                .openItem(itemId: "i", databaseKey: "tasks"),
                .openApprovals,
                .openStatus,
                .openHistory,
                .openNewChat
            ]
        )
        let router = SempRouterSpy()
        let viewModel = SempThreadViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 6 }
        observer.cancel()
        XCTAssertEqual(
            router.calls,
            [.run("r", "m"), .item("i", "tasks"), .approvals, .status, .history, .newChat]
        )
        viewModel.send(.send("Hi"))
        viewModel.retry()
        viewModel.refresh()
        XCTAssertEqual(model.actions, [.send("Hi"), .retry, .refresh])
    }

    // MARK: - History
    @MainActor
    func testTheHistoryRoutesAThreadTheApprovalsAndANewChat() async throws {
        let row = SempChatRow(id: "t1", type: .tick, title: "Weekly", lastActivityAt: "2026-10-21T13:21:00.000Z")
        let model = ScriptedSempChatsScreenModel(
            state: SempChatsState(phase: .ready, rows: [row]),
            effects: [.openThread(row), .openApprovals, .openNewChat]
        )
        let router = SempRouterSpy()
        let viewModel = SempChatsViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 3 }
        observer.cancel()
        XCTAssertEqual(router.calls, [.thread("t1", .tick, "Weekly"), .approvals, .newChat])
        viewModel.send(.setQuery("faktura"))
        viewModel.retry()
        XCTAssertEqual(model.actions, [.setQuery("faktura"), .retry])
    }

    // MARK: - Status
    @MainActor
    func testTheStatusRoutesTheChatTheThreadAndTheProject() async throws {
        let model = ScriptedSempStatusScreenModel(
            state: SempStatusState(phase: .ready),
            effects: [
                .openChat(threadId: "t", messageId: "m"),
                .openThread(threadId: "h"),
                .openProject(projectId: "p")
            ]
        )
        let router = SempRouterSpy()
        let viewModel = SempStatusViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 3 }
        observer.cancel()
        XCTAssertEqual(router.calls, [.chat("t", "m"), .thread("h", .tick, nil), .project("p")])
        viewModel.send(.fix(issueId: "p1"))
        XCTAssertEqual(model.actions, [.fix(issueId: "p1")])
    }

    // MARK: - Run
    @MainActor
    func testTheRunRoutesTheThreadAndTheApprovals() async throws {
        let model = ScriptedSempRunScreenModel(
            state: SempRunState(phase: .ready),
            effects: [.openThread(threadId: "t"), .openApprovals]
        )
        let router = SempRouterSpy()
        let viewModel = SempRunViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 2 }
        observer.cancel()
        XCTAssertEqual(router.calls, [.thread("t", .chat, nil), .approvals])
        viewModel.send(.retryRun)
        XCTAssertEqual(model.actions, [.retryRun])
    }

    // MARK: - Approvals
    @MainActor
    func testTheApprovalsRouteTheThreadAndTheRun() async throws {
        let model = ScriptedSempApprovalsScreenModel(
            state: SempApprovalsState(phase: .ready),
            effects: [.openThread(threadId: "t"), .openRun(runId: "r")]
        )
        let router = SempRouterSpy()
        let viewModel = SempApprovalsViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 2 }
        observer.cancel()
        XCTAssertEqual(router.calls, [.thread("t", .chat, nil), .run("r", nil)])
        viewModel.send(.decide(approvalId: "a", approve: true))
        XCTAssertEqual(model.actions, [.decide(approvalId: "a", approve: true)])
    }

    // MARK: - Project agent
    @MainActor
    func testTheProjectAgentRoutesATaskThreadAndARun() async throws {
        let model = ScriptedSempProjectAgentScreenModel(
            state: SempProjectAgentState(phase: .ready),
            effects: [.openThread(threadId: "t"), .openRun(runId: "r", messageId: "m")]
        )
        let router = SempRouterSpy()
        let viewModel = SempProjectAgentViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 2 }
        observer.cancel()
        XCTAssertEqual(router.calls, [.thread("t", .tick, nil), .run("r", "m")])
        viewModel.send(.saveSection(.allowed, text: "- read"))
        XCTAssertEqual(model.actions, [.saveSection(.allowed, text: "- read")])
    }

    // MARK: - Bubble
    @MainActor
    func testTheBubbleForwardsADropAndRoutesTheThreadOfAnInboxItem() async throws {
        let model = ScriptedSempBubbleScreenModel(
            state: SempBubbleState(badge: 2),
            effects: [.openItemThread(inboxItemId: "i", title: "Call", meta: "today")]
        )
        let router = SempRouterSpy()
        let viewModel = SempBubbleViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }

        try await eventually { router.calls.count == 1 }
        observer.cancel()
        XCTAssertEqual(router.calls, [.itemThread("i", "Call", "today")])
        XCTAssertEqual(viewModel.state.badge, 2)
        let target = SempTarget(kind: .task, title: "Send invoice", itemId: "i1", databaseId: "d1")
        viewModel.drop(target)
        viewModel.refresh()
        XCTAssertEqual(model.actions, [.drop(target), .refresh])
    }

    // MARK: - Lifetime
    @MainActor
    func testReleasingAViewModelReleasesItsModel() {
        weak var weakModel: ScriptedSempThreadScreenModel?
        var viewModel: SempThreadViewModel?
        do {
            let model = ScriptedSempThreadScreenModel(state: SempThreadState(phase: .ready))
            weakModel = model
            viewModel = SempThreadViewModel(model: model, router: SempRouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
    }

    // MARK: - Waiting
    @MainActor
    private func eventually(timeout: TimeInterval = 5, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("The condition did not hold in time") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}
