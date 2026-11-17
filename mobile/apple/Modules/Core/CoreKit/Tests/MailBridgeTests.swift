import XCTest

@testable import CoreKit

/// Drives the real Kotlin mail ViewModels through their bridges. No server is signed in, so every load ends in the
/// unauthorized failure the Kotlin layer answers without a request; the actions that need no data (opening a row,
/// leaving) work as with a server.
final class MailBridgeTests: XCTestCase {

    // MARK: - Loads without a session
    @MainActor
    func testEveryMailScreenWithoutASessionEndsInTheUnauthorizedFailure() async {
        let factory = isolatedFactory()
        let threads = factory.makeMailThreads(start: MailListStart())
        let thread = factory.makeMailThread(threadId: "t1")
        let compose = factory.makeMailCompose(start: .draft(draftId: "d1"))
        let folders = factory.makeMailFolders()
        let accounts = factory.makeMailAccounts()
        let account = factory.makeMailAccount(mailboxId: "m1")
        let threadsState = await firstState(of: threads) { $0.phase != .loading }
        let threadState = await firstState(of: thread) { $0.phase != .loading }
        let composeState = await firstState(of: compose) { $0.phase != .loading }
        let foldersState = await firstState(of: folders) { $0.phase != .loading }
        let accountsState = await firstState(of: accounts) { $0.phase != .loading }
        let accountState = await firstState(of: account) { $0.phase != .loading }
        XCTAssertEqual(threadsState?.phase, .failure(.unauthorized))
        XCTAssertEqual(threadState?.phase, .failure(.unauthorized))
        XCTAssertEqual(composeState?.phase, .failure(.unauthorized))
        XCTAssertEqual(foldersState?.phase, .failure(.unauthorized))
        XCTAssertEqual(accountsState?.phase, .failure(.unauthorized))
        XCTAssertEqual(accountState?.phase, .failure(.unauthorized))
    }

    @MainActor
    func testTheStartOfTheListReachesTheKotlinViewModel() async throws {
        let start = MailListStart(areaId: "a1", projectId: "p1", box: .flagged, mailboxId: "m1", folderId: "f1")
        let model = try XCTUnwrap(
            isolatedFactory().makeMailThreads(start: start) as? SharedMailThreadsScreenModel
        )
        let state = model.state
        XCTAssertEqual(state.areaId, "a1")
        XCTAssertEqual(state.projectId, "p1")
        XCTAssertEqual(state.box, .flagged)
        XCTAssertEqual(state.mailboxId, "m1")
        XCTAssertEqual(state.folderId, "f1")
    }

    // A retry replaces the Kotlin state with a new value (through loading), so a state that is another object than the
    // one before shows that the Kotlin ViewModel loaded again.
    @MainActor
    func testRetryMakesTheKotlinThreadListLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeMailThreads(start: MailListStart()) as? SharedMailThreadsScreenModel
        )
        _ = await firstState(of: model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await firstState(of: model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.phase, .failure(.unauthorized))
    }

    // MARK: - Effects
    @MainActor
    func testOpeningDeliversEachEffectOnceInOrder() async {
        let model = isolatedFactory().makeMailThreads(start: MailListStart())
        model.send(.open(.openThread(threadId: "t1")))
        model.send(.open(.compose))
        let buffered = await effects(of: model, count: 2)
        XCTAssertEqual(buffered, [.openThread(threadId: "t1"), .compose])
        model.send(.open(.openAccount(mailboxId: "m1")))
        let next = await effects(of: model, count: 1)
        XCTAssertEqual(next, [.openAccount(mailboxId: "m1")])
        let none = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(none, [], "A delivered effect must not be delivered again")
    }

    @MainActor
    func testTheFoldersScreenRaisesTheListEachRowStandsFor() async {
        let model = isolatedFactory().makeMailFolders()
        model.send(.openBox(.sempDrafts))
        model.send(.openAccounts)
        let raised = await effects(of: model, count: 2)
        XCTAssertEqual(raised, [.openList(MailListStart(box: .sempDrafts), title: nil), .openAccounts])
    }

    @MainActor
    func testTheThreadScreenRaisesNothingForARefusedReplyAndTheTaskItWasAskedFor() async {
        let model = isolatedFactory().makeMailThread(threadId: "t1")
        model.send(.open(.task(taskId: "k1")))
        model.send(.open(.reply(.reply)))
        let raised = await effects(of: model, count: 1)
        XCTAssertEqual(raised, [.openTask(taskId: "k1")])
        let none = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(none, [], "A reply of a thread that is not loaded has no message to answer")
    }

    @MainActor
    func testLeavingAComposeScreenWithoutADraftClosesAtOnce() async {
        let model = isolatedFactory().makeMailCompose(start: .new)
        _ = await firstState(of: model) { $0.phase != .loading }
        model.send(.cancel)
        let closed = await effects(of: model, count: 1)
        XCTAssertEqual(closed, [.close])
    }

    // MARK: - Lifetime
    @MainActor
    func testReleasingAMailBridgeClosesItsKotlinViewModel() async throws {
        var model: SharedMailThreadsScreenModel? = try XCTUnwrap(
            isolatedFactory().makeMailThreads(start: MailListStart()) as? SharedMailThreadsScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished, "Closing the Kotlin ViewModel must end its effect stream")
    }

    @MainActor
    func testReleasingTheOtherMailBridgesClosesTheirKotlinViewModels() throws {
        let factory = isolatedFactory()
        var models: [any AnyObject] = [
            factory.makeMailThread(threadId: "t1"),
            factory.makeMailCompose(start: .new),
            factory.makeMailFolders(),
            factory.makeMailAccounts(),
            factory.makeMailAccount(mailboxId: "m1")
        ]
        let leases = try [
            XCTUnwrap((models[0] as? SharedMailThreadScreenModel)?.lease),
            XCTUnwrap((models[1] as? SharedMailComposeScreenModel)?.lease),
            XCTUnwrap((models[2] as? SharedMailFoldersScreenModel)?.lease),
            XCTUnwrap((models[3] as? SharedMailAccountsScreenModel)?.lease),
            XCTUnwrap((models[4] as? SharedMailAccountScreenModel)?.lease)
        ]
        XCTAssertTrue(leases.allSatisfy { !$0.isClosed })
        models.removeAll()
        XCTAssertTrue(leases.allSatisfy(\.isClosed))
    }

    // MARK: - Helpers
    @MainActor
    private func firstState<Model: ScreenModel>(
        of model: Model,
        timeout: TimeInterval = 5,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = MailReceived<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.values.append(state)
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: timeout)
        observer.cancel()
        return found.values.first
    }

    @MainActor
    private func effects<Model: ScreenModel>(
        of model: Model,
        count: Int,
        timeout: TimeInterval = 5
    ) async -> [Model.Effect] {
        let received = MailReceived<Model.Effect>()
        let complete = XCTestExpectation(description: "\(count) effects arrived")
        let observer = Task { @MainActor in
            for await effect in model.effects() {
                received.values.append(effect)
                if received.values.count == count {
                    complete.fulfill()
                    return
                }
            }
        }
        _ = await XCTWaiter.fulfillment(of: [complete], timeout: timeout)
        observer.cancel()
        return received.values
    }

    @MainActor
    private func finishes<Element>(_ stream: AsyncStream<Element>, within timeout: TimeInterval) async -> Bool {
        let finished = XCTestExpectation(description: "The stream finished")
        let iteration = Task { @MainActor in
            for await _ in stream {}
            finished.fulfill()
        }
        let result = await XCTWaiter.fulfillment(of: [finished], timeout: timeout)
        iteration.cancel()
        return result == .completed
    }
}

/// Values a test task received on the main actor.
@MainActor
private final class MailReceived<Value> {

    // MARK: - Properties
    var values: [Value] = []
}
