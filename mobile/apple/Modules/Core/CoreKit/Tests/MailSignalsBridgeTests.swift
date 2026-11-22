import XCTest

@testable import CoreKit

/// Drives the real Kotlin mail signals ViewModel through its bridge. No server is signed in, so the load ends in the
/// unauthorized failure the Kotlin layer answers without a request; typing into a field needs no data.
final class MailSignalsBridgeTests: XCTestCase {

    @MainActor
    func testWithoutASessionTheSignalsEndInTheUnauthorizedFailure() async throws {
        let model = isolatedFactory().makeProjectMailSignals(projectId: "p1")
        let state = await firstState(of: model) { $0.phase != .loading }
        XCTAssertEqual(state, ProjectMailSignalsState(phase: .error, failure: .unauthorized))
    }

    // A retry replaces the Kotlin state with a new value (through loading), so a state that is another object than
    // the one before shows that the Kotlin ViewModel loaded again.
    @MainActor
    func testRetryMakesTheKotlinViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeProjectMailSignals(projectId: "p1") as? SharedProjectMailSignalsScreenModel
        )
        _ = await firstState(of: model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await firstState(of: model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.failure, .unauthorized)
    }

    @MainActor
    func testTheTypedTextLivesInTheKotlinState() {
        let model = isolatedFactory().makeProjectMailSignals(projectId: "p1")
        model.send(.editInput(.domains, text: "novak.cz"))
        model.send(.editInput(.addresses, text: "petr@"))
        model.send(.editInput(.keywords, text: "faktura"))
        XCTAssertEqual(model.state.domainInput, "novak.cz")
        XCTAssertEqual(model.state.addressInput, "petr@")
        XCTAssertEqual(model.state.keywordInput, "faktura")
        XCTAssertEqual(model.state.domains, [], "Nothing is added before the signals loaded")
    }

    @MainActor
    func testTheEffectsFinishAtOnce() async {
        let model = isolatedFactory().makeProjectMailSignals(projectId: "p1")
        var count = 0
        for await _ in model.effects() { count += 1 }
        XCTAssertEqual(count, 0)
    }

    @MainActor
    func testReleasingTheBridgeClosesTheKotlinViewModel() throws {
        var model: SharedProjectMailSignalsScreenModel? = try XCTUnwrap(
            isolatedFactory().makeProjectMailSignals(projectId: "p1") as? SharedProjectMailSignalsScreenModel
        )
        let viewModel = try XCTUnwrap(model?.viewModel)
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        XCTAssertTrue(viewModel.isClosed)
    }
}

// MARK: - Helpers
// The helper waits with a timeout and then cancels its task, so a stream that ignores cancellation fails the test
// instead of hanging it.
private extension MailSignalsBridgeTests {

    @MainActor
    func firstState<Model: ScreenModel>(
        of model: Model,
        timeout: TimeInterval = 5,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = SignalsReceived<Model.State>()
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
}

/// Values a test task received on the main actor.
@MainActor
private final class SignalsReceived<Value> {

    // MARK: - Properties
    var values: [Value] = []
}
