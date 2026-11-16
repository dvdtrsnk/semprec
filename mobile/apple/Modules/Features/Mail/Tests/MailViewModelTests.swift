import CoreKit
import XCTest

@testable import MailFeature

final class MailViewModelTests: XCTestCase {

    // MARK: - Thread list
    @MainActor
    func testTheListStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedMailThreadsScreenModel(state: MailThreadsState())
        let viewModel = MailThreadsViewModel(model: model, router: MailRouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(MailThreadsState(phase: .content, search: "petr"))
        try await eventually { viewModel.state.search == "petr" }
        model.publish(MailThreadsState(phase: .failure(.unavailable)))
        try await eventually { viewModel.state.phase == .failure(.unavailable) }
    }

    @MainActor
    func testListIntentsAreForwardedToTheModel() {
        let model = ScriptedMailThreadsScreenModel(state: MailThreadsState())
        let viewModel = MailThreadsViewModel(model: model, router: MailRouterSpy())
        viewModel.send(.retry)
        viewModel.send(.search("is:unread"))
        viewModel.send(.toggleRead(threadId: "t1"))
        XCTAssertEqual(model.actions, [.retry, .search("is:unread"), .toggleRead(threadId: "t1")])
    }

    @MainActor
    func testEveryListEffectReachesTheRouterOnce() async throws {
        let router = MailRouterSpy()
        let model = ScriptedMailThreadsScreenModel(state: MailThreadsState())
        let viewModel = MailThreadsViewModel(model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(.openFolders)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openThread(threadId: "t1"))
        model.emit(.compose)
        model.emit(.openAccount(mailboxId: "m1"))
        try await eventually { router.calls.count == 4 }
        XCTAssertEqual(router.calls, ["folders", "thread t1", "compose new", "account m1"])
    }

    @MainActor
    func testTheListReloadsInPlaceWhenItShowsAgainButNotTheFirstTime() {
        let model = ScriptedMailThreadsScreenModel(state: MailThreadsState())
        let viewModel = MailThreadsViewModel(model: model, router: MailRouterSpy())
        viewModel.appeared()
        XCTAssertEqual(model.actions, [])
        viewModel.appeared()
        XCTAssertEqual(model.actions, [.refresh])
    }

    @MainActor
    func testRefreshReturnsOnceTheListIsNotRefreshingAnymore() async throws {
        let model = ScriptedMailThreadsScreenModel(state: MailThreadsState(phase: .content, refreshing: true))
        let viewModel = MailThreadsViewModel(model: model, router: MailRouterSpy())
        let finished = MailFlag()
        let refresh = Task { @MainActor in
            await viewModel.refresh()
            finished.value = true
        }
        defer { refresh.cancel() }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.actions, [.refresh])
        XCTAssertFalse(finished.value, "A pull to refresh lasts while the list refreshes")
        model.publish(MailThreadsState(phase: .content, refreshing: false))
        try await eventually { finished.value }
    }

    // MARK: - Thread
    @MainActor
    func testThreadIntentsAreForwardedAndEffectsRouted() async throws {
        let router = MailRouterSpy()
        let model = ScriptedMailThreadScreenModel(state: MailThreadState())
        let viewModel = MailThreadViewModel(model: model, router: router)
        viewModel.send(.toggleFlag)
        viewModel.send(.move(.archive))
        viewModel.send(.sendDraft(body: "Text"))
        XCTAssertEqual(model.actions, [.toggleFlag, .move(.archive), .sendDraft(body: "Text")])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.compose(.reply(sourceEmailId: "e1", mailboxId: "m1", mode: .replyAll)))
        model.emit(.openTask(taskId: "k1"))
        model.emit(.close)
        try await eventually { router.calls.count == 2 && viewModel.closeRequests == 1 }
        XCTAssertEqual(router.calls, ["compose reply e1 m1", "task k1"])
    }

    // MARK: - Compose
    @MainActor
    func testComposeForwardsIntentsAndRequestsToCloseOnTheEffect() async throws {
        let model = ScriptedMailComposeScreenModel(state: MailComposeState())
        let viewModel = MailComposeViewModel(model: model)
        viewModel.send(.send(subject: "S", body: "B"))
        viewModel.send(.cancel)
        XCTAssertEqual(model.actions, [.send(subject: "S", body: "B"), .cancel])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.close)
        try await eventually { viewModel.closeRequests == 1 }
    }

    // MARK: - Mailboxes
    @MainActor
    func testFoldersRouteTheListsTheEffectsNameAndTheirActionsAreForwarded() async throws {
        let router = MailRouterSpy()
        let model = ScriptedMailFoldersScreenModel(state: MailFoldersState())
        let viewModel = MailFoldersViewModel(model: model, router: router)
        viewModel.send(.openBox(.flagged))
        XCTAssertEqual(model.actions, [.openBox(.flagged)])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openList(MailListStart(mailboxId: "m1", folderId: "f1"), title: "Klienti"))
        model.emit(.compose)
        model.emit(.openAccounts)
        try await eventually { router.calls.count == 3 }
        XCTAssertEqual(router.calls, ["list Klienti m1 f1", "compose new", "accounts"])
    }

    // MARK: - Accounts
    @MainActor
    func testAccountsRouteTheOpenedAccountAndCountConnections() async throws {
        let router = MailRouterSpy()
        let model = ScriptedMailAccountsScreenModel(state: MailAccountsState())
        let viewModel = MailAccountsViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openAccount(mailboxId: "m1"))
        model.emit(.connected)
        try await eventually { router.calls.count == 1 && viewModel.connections == 1 }
        XCTAssertEqual(router.calls, ["account m1"])
    }

    @MainActor
    func testAccountRequestsToCloseWhenItWasRemoved() async throws {
        let model = ScriptedMailAccountScreenModel(state: MailAccountState())
        let viewModel = MailAccountViewModel(model: model)
        viewModel.send(.requestRemoval)
        XCTAssertEqual(model.actions, [.requestRemoval])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.removed)
        try await eventually { viewModel.closeRequests == 1 }
    }

    // MARK: - Lifetime
    @MainActor
    func testReleasingAViewModelReleasesItsModel() {
        weak var weakThreads: ScriptedMailThreadsScreenModel?
        weak var weakThread: ScriptedMailThreadScreenModel?
        var threads: MailThreadsViewModel?
        var thread: MailThreadViewModel?
        do {
            let threadsModel = ScriptedMailThreadsScreenModel(state: MailThreadsState())
            let threadModel = ScriptedMailThreadScreenModel(state: MailThreadState())
            weakThreads = threadsModel
            weakThread = threadModel
            threads = MailThreadsViewModel(model: threadsModel, router: MailRouterSpy())
            thread = MailThreadViewModel(model: threadModel, router: MailRouterSpy())
        }
        XCTAssertNotNil(weakThreads)
        XCTAssertNotNil(weakThread)
        threads = nil
        thread = nil
        XCTAssertNil(weakThreads)
        XCTAssertNil(weakThread)
        XCTAssertNil(threads)
        XCTAssertNil(thread)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}

// MARK: - Spies
/// A flag a test task sets on the main actor.
@MainActor
final class MailFlag {

    // MARK: - Properties
    var value = false
}

@MainActor
final class MailRouterSpy: MailRouting {

    // MARK: - Properties
    private(set) var calls: [String] = []

    // MARK: - Protocol conformance
    func showList(_ start: MailListStart, title: String?) {
        calls.append("list \(title ?? "-") \(start.mailboxId ?? "-") \(start.folderId ?? "-")")
    }

    func showThread(threadId: String) {
        calls.append("thread \(threadId)")
    }

    func showFolders() {
        calls.append("folders")
    }

    func showCompose(_ start: MailComposeStart) {
        switch start {
        case .new: calls.append("compose new")
        case .reply(let source, let mailbox, _): calls.append("compose reply \(source) \(mailbox)")
        case .draft(let id): calls.append("compose draft \(id)")
        }
    }

    func showAccounts() {
        calls.append("accounts")
    }

    func showAccount(mailboxId: String) {
        calls.append("account \(mailboxId)")
    }

    func showTask(taskId: String) {
        calls.append("task \(taskId)")
    }
}
