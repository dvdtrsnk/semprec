import XCTest

@testable import CoreKit

/// Drives the real Kotlin ViewModels through the native bridges.
final class SharedScreenModelTests: XCTestCase {

    // MARK: - Properties
    private let items = (1...5).map { PlaceholderItem(id: "item-\($0)", ordinal: $0) }

    // MARK: - Tests
    @MainActor
    func testHomeReachesTheSharedItemsInOrder() async {
        let model = SharedScreenModelFactory().makeHome()
        let state = await waitForState(model) { $0 != .loading }
        XCTAssertEqual(state, .content(items))
        XCTAssertEqual(model.state, .content(items))
    }

    // The in-memory repository never fails, so a reload ends in content equal to the content before it. What shows
    // that the Kotlin ViewModel loaded again is its state value: a load replaces it (through LOADING) with a new
    // value, while an action that reaches no load leaves the same value in place.
    @MainActor
    func testRetryMakesTheKotlinHomeViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(SharedScreenModelFactory().makeHome() as? SharedHomeScreenModel)
        _ = await waitForState(model) { $0 != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0 != .loading }
        XCTAssertEqual(reloaded, .content(items))
    }

    @MainActor
    func testDetailMapsAKnownItemAndAnUnknownId() async {
        let factory = SharedScreenModelFactory()
        let known = await waitForState(factory.makeDetail(itemId: "item-3")) { $0 != .loading }
        XCTAssertEqual(known, .content(PlaceholderItem(id: "item-3", ordinal: 3)))
        let unknown = await waitForState(factory.makeDetail(itemId: "item-6")) { $0 != .loading }
        XCTAssertEqual(unknown, .notFound)
    }

    @MainActor
    func testRetryMakesTheKotlinDetailViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(SharedScreenModelFactory().makeDetail(itemId: "item-3") as? SharedDetailScreenModel)
        _ = await waitForState(model) { $0 != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0 != .loading }
        XCTAssertEqual(reloaded, .content(PlaceholderItem(id: "item-3", ordinal: 3)))
    }

    @MainActor
    func testSelectingItemsDeliversEachOpenDetailEffectOnce() async {
        let model = SharedScreenModelFactory().makeHome()
        model.send(.selectItem(id: "item-2"))
        model.send(.selectItem(id: "item-4"))
        let buffered = await effects(of: model, count: 2)
        XCTAssertEqual(buffered, [.openDetail(id: "item-2"), .openDetail(id: "item-4")])
        model.send(.selectItem(id: "item-5"))
        let next = await effects(of: model, count: 1)
        XCTAssertEqual(next, [.openDetail(id: "item-5")], "A new collector must not receive delivered effects again")
    }

    @MainActor
    func testAnObserverCancelledBeforeTakingAnEffectLeavesItToTheNextObserver() async throws {
        let model = SharedScreenModelFactory().makeHome()
        model.send(.selectItem(id: "item-2"))
        try await letEffectsReachTheBridge()
        let receivedByCancelled = Received<HomeEffect>()
        let ended = expectation(description: "The cancelled observer's stream ended")
        let cancelled = Task { @MainActor in
            for await effect in model.effects() { receivedByCancelled.values.append(effect) }
            ended.fulfill()
        }
        cancelled.cancel()
        await fulfillment(of: [ended], timeout: 5)
        let receivedByNext = await effects(of: model, count: 1)
        XCTAssertEqual(receivedByCancelled.values, [], "A cancelled observer must not take effects")
        XCTAssertEqual(receivedByNext, [.openDetail(id: "item-2")])
    }

    @MainActor
    func testAnObserverThatStopsLeavesTheEffectsItDidNotTakeToTheNextObserver() async throws {
        let model = SharedScreenModelFactory().makeHome()
        model.send(.selectItem(id: "item-2"))
        model.send(.selectItem(id: "item-4"))
        try await letEffectsReachTheBridge()
        let first = await effects(of: model, count: 1)
        let second = await effects(of: model, count: 1)
        XCTAssertEqual(first, [.openDetail(id: "item-2")])
        XCTAssertEqual(second, [.openDetail(id: "item-4")])
    }

    @MainActor
    func testObservingAgainAfterCancellationDeliversEveryEffectOnceInOrder() async throws {
        let model = SharedScreenModelFactory().makeHome()
        let log = DeliveryLog()
        let firstEnded = expectation(description: "The first observation ended")
        let first = Task {
            await model.observe(onState: { _ in }, onEffect: { log.record($0, by: 1) })
            firstEnded.fulfill()
        }
        model.send(.selectItem(id: "item-1"))
        try await eventually { log.deliveries.count == 1 }
        // Raised as the screen goes away (a pushed detail), then one while nobody observes; back on screen, the
        // restarted observer receives both.
        model.send(.selectItem(id: "item-2"))
        first.cancel()
        await fulfillment(of: [firstEnded], timeout: 5)
        model.send(.selectItem(id: "item-3"))
        let secondEnded = expectation(description: "The second observation ended")
        let second = Task {
            await model.observe(onState: { _ in }, onEffect: { log.record($0, by: 2) })
            secondEnded.fulfill()
        }
        try await eventually { log.deliveries.count == 3 }
        second.cancel()
        await fulfillment(of: [secondEnded], timeout: 5)
        let later = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(log.deliveries, [
            Delivery(observer: 1, effect: .openDetail(id: "item-1")),
            Delivery(observer: 2, effect: .openDetail(id: "item-2")),
            Delivery(observer: 2, effect: .openDetail(id: "item-3"))
        ])
        XCTAssertEqual(later, [], "A delivered effect must not be delivered again")
    }

    @MainActor
    func testSettingsListsAboutAndSelectingItShowsAbout() async {
        let model = SharedScreenModelFactory().makeSettings()
        XCTAssertEqual(model.state, SettingsState(rows: [.about]))
        model.send(.selectRow(.about))
        let received = await effects(of: model, count: 1)
        XCTAssertEqual(received, [.showAbout])
    }

    @MainActor
    func testCancellingTheObserverEndsTheStateStream() async {
        let model = SharedScreenModelFactory().makeHome()
        let entered = expectation(description: "Observer received a state")
        entered.assertForOverFulfill = false
        let exited = expectation(description: "Observer ended")
        let observer = Task { @MainActor in
            for await _ in model.states() { entered.fulfill() }
            exited.fulfill()
        }
        await fulfillment(of: [entered], timeout: 5)
        observer.cancel()
        await fulfillment(of: [exited], timeout: 5)
    }

    @MainActor
    func testReleasingTheBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedHomeScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeHome() as? SharedHomeScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        // Only close() closes the Kotlin effect channel; its end finishes the queue, which ends this stream.
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished)
    }

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

// MARK: - Deliveries
private struct Delivery: Equatable {

    // MARK: - Properties
    let observer: Int
    let effect: HomeEffect
}

/// The effects observers received, in the order they received them.
@MainActor
private final class DeliveryLog {

    // MARK: - Properties
    private(set) var deliveries: [Delivery] = []

    // MARK: - Methods
    func record(_ effect: HomeEffect, by observer: Int) {
        deliveries.append(Delivery(observer: observer, effect: effect))
    }
}
