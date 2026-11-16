import XCTest

@testable import CoreKit

/// Drives the real Kotlin Inbox ViewModel through its bridge. No server is signed in, so the load ends in the
/// unauthorized failure the Kotlin layer answers without a request; the actions that need no data work as with a
/// server.
final class InboxBridgeTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testInboxWithoutASessionEndsInTheUnauthorizedFailure() async {
        let model = SharedScreenModelFactory().makeInbox()
        let state = await firstState(of: model) { $0 != .loading }
        XCTAssertEqual(state, .failure(.unauthorized))
        XCTAssertEqual(model.state, .failure(.unauthorized))
    }

    // A retry replaces the Kotlin state with a new value (through loading), so a state that is another object than
    // the one before shows that the Kotlin ViewModel loaded again.
    @MainActor
    func testRetryMakesTheKotlinInboxLoadAgain() async throws {
        let model = try XCTUnwrap(SharedScreenModelFactory().makeInbox() as? SharedInboxScreenModel)
        _ = await firstState(of: model) { $0 != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await firstState(of: model) { $0 != .loading }
        XCTAssertEqual(reloaded, .failure(.unauthorized))
    }

    @MainActor
    func testOpeningAResultThatIsNotThereRaisesNothing() async {
        let model = SharedScreenModelFactory().makeInbox()
        model.send(.openResult)
        model.send(.dismissResult)
        model.send(.dismissProblem)
        let none = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(none, [])
    }

    @MainActor
    func testReleasingTheInboxBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedInboxScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeInbox() as? SharedInboxScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished, "Closing the Kotlin ViewModel must end its effect stream")
    }
}

// MARK: - Helpers
// The helpers that iterate a stream wait with a timeout and then cancel their task, so a stream that ignores
// cancellation fails the test instead of hanging it.
private extension InboxBridgeTests {

    @MainActor
    func firstState<Model: ScreenModel>(
        of model: Model,
        timeout: TimeInterval = 5,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Received<Model.State>()
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
    func effects<Model: ScreenModel>(of model: Model, count: Int, timeout: TimeInterval = 5) async -> [Model.Effect] {
        let received = Received<Model.Effect>()
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
    func finishes<Element>(_ stream: AsyncStream<Element>, within timeout: TimeInterval) async -> Bool {
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
private final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}
