import XCTest

@testable import CoreKit

/// The delivery rules of `EffectQueue` on their own. `SharedScreenModelTests` drives them through the Kotlin
/// ViewModels.
final class EffectQueueTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testEffectsSentBeforeAnyStreamGoToTheFirstObserverInOrder() async {
        let queue = EffectQueue<Int>()
        queue.send(1)
        queue.send(2)
        let first = await elements(of: queue.stream(), upTo: 2)
        XCTAssertEqual(first.received, [1, 2])
    }

    @MainActor
    func testANewerStreamEndsTheOlderOneAndReceivesTheLaterEffects() async {
        let queue = EffectQueue<Int>()
        let older = queue.stream()
        let newer = queue.stream()
        queue.send(1)
        let olderResult = await elements(of: older, upTo: 1)
        let newerResult = await elements(of: newer, upTo: 1)
        XCTAssertEqual(olderResult.received, [])
        XCTAssertTrue(olderResult.ended)
        XCTAssertEqual(newerResult.received, [1])
    }

    @MainActor
    func testCancellingAWaitingObserverEndsItsStreamAndLeavesLaterEffectsToTheNextOne() async throws {
        let queue = EffectQueue<Int>()
        let iteration = Iteration()
        let ended = expectation(description: "The cancelled observer's stream ended")
        let observer = Task { @MainActor in
            for await effect in queue.stream() { iteration.received.append(effect) }
            ended.fulfill()
        }
        queue.send(1)
        try await eventually { iteration.received == [1] }
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
        queue.send(2)
        let next = await elements(of: queue.stream(), upTo: 1)
        XCTAssertEqual(iteration.received, [1])
        XCTAssertEqual(next.received, [2])
    }

    @MainActor
    func testAWaitingObserverCancelledJustBeforeAnEffectArrivesLeavesItToTheNextObserver() async throws {
        let queue = EffectQueue<Int>()
        // The sleep lets the observer start waiting. Cancelled, it wakes on another thread while the effect is sent
        // here, so each round races the two.
        for round in 1...20 {
            let cancelled = Iteration()
            let ended = expectation(description: "The cancelled observer's stream ended")
            let observer = Task { @MainActor in
                for await effect in queue.stream() { cancelled.received.append(effect) }
                ended.fulfill()
            }
            try await Task.sleep(for: .milliseconds(5))
            observer.cancel()
            queue.send(round)
            await fulfillment(of: [ended], timeout: 5)
            let next = await elements(of: queue.stream(), upTo: 1)
            XCTAssertEqual(cancelled.received, [], "Round \(round)")
            XCTAssertEqual(next.received, [round], "Round \(round)")
        }
    }

    @MainActor
    func testFinishEndsTheStreamOnceTheQueuedEffectsAreTaken() async {
        let queue = EffectQueue<Int>()
        queue.send(1)
        queue.finish()
        let result = await elements(of: queue.stream(), upTo: 2)
        XCTAssertEqual(result.received, [1])
        XCTAssertTrue(result.ended)
    }
}

// MARK: - Helpers
private extension EffectQueueTests {

    /// Iterates `stream` in a new task until it has `count` elements, ends by itself, or `timeout` seconds pass; then
    /// cancels that task, so a stream that ignores cancellation fails the test instead of hanging it.
    @MainActor
    func elements(
        of stream: AsyncStream<Int>,
        upTo count: Int,
        timeout: TimeInterval = 5
    ) async -> (received: [Int], ended: Bool) {
        let iteration = Iteration()
        let stopped = XCTestExpectation(description: "The iteration stopped")
        let task = Task { @MainActor in
            for await element in stream {
                iteration.received.append(element)
                if iteration.received.count == count {
                    stopped.fulfill()
                    return
                }
            }
            iteration.ended = true
            stopped.fulfill()
        }
        _ = await XCTWaiter.fulfillment(of: [stopped], timeout: timeout)
        task.cancel()
        return (iteration.received, iteration.ended)
    }

    @MainActor
    func eventually(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
    }
}

// MARK: - Iteration
/// What a test task received from a stream on the main actor, and whether the stream ended by itself.
@MainActor
private final class Iteration {

    // MARK: - Properties
    var received: [Int] = []
    var ended = false
}
