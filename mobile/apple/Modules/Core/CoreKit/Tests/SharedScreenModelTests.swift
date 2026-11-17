import XCTest

@testable import CoreKit

/// Drives the real Kotlin ViewModels through the native bridges.
final class SharedScreenModelTests: XCTestCase {

    // MARK: - Tests
    func testLeaseRunsItsReleaseOnce() {
        var closes = 0
        let lease = SharedViewModelLease { closes += 1 }
        lease.close()
        lease.close()
        XCTAssertEqual(closes, 1)
        XCTAssertTrue(lease.isClosed)
    }
}

// MARK: - Helpers
// The helpers that iterate a stream wait with a timeout and then cancel their task, so a stream that ignores
// cancellation fails the test instead of hanging it.
private extension SharedScreenModelTests {

    /// The first state of `model` that matches `predicate`, or `nil` when none arrives within `timeout` seconds.
    @MainActor
    func waitForState<Model: ScreenModel>(
        _ model: Model,
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

    /// The effects one new observer receives until it has `count` of them, after which it stops iterating, or until
    /// `timeout` seconds pass.
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
    func eventually(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
    }

    /// Gives effects time to travel from the Kotlin channel to the bridge before an observer starts. The assertions
    /// hold for any arrival time; an earlier arrival only makes the scenario stricter.
    @MainActor
    func letEffectsReachTheBridge() async throws {
        try await Task.sleep(for: .milliseconds(200))
    }

    /// `true` when `stream` finishes by itself within `timeout` seconds.
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
