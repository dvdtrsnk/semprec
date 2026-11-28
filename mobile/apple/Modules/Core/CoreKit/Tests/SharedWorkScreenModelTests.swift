import XCTest

@testable import CoreKit

/// Drives the real Kotlin Tasks and Podrobnosti ViewModels through the native bridges. The test host has no stored
/// session, so each ViewModel answers its first load as unauthorized without reaching a server.
final class SharedWorkScreenModelTests: XCTestCase {

    // MARK: - Tasks
    @MainActor
    func testTasksStartWhereTheStartSaysAndFailAsUnauthorizedWithoutASession() async throws {
        let start = TasksStart(tab: .all, hideDone: true, projectId: "p1")
        let model = isolatedFactory().makeTasks(start: start)
        XCTAssertEqual(model.state.tab, .all)
        XCTAssertTrue(model.state.hideDone)
        XCTAssertEqual(model.state.projectId, "p1")
        let state = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(state?.phase, .failure(.unauthorized))
    }

    // A failed load ends in the same failure, so what shows that the Kotlin ViewModel loaded again is its state
    // value: a load replaces it (through LOADING) with a new value.
    @MainActor
    func testRetryMakesTheKotlinTasksViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(isolatedFactory().makeTasks(start: TasksStart()) as? SharedTasksScreenModel)
        _ = await waitForState(model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.phase, .failure(.unauthorized))
    }

    @MainActor
    func testFilterActionsReachTheKotlinViewModel() async throws {
        let model = isolatedFactory().makeTasks(start: TasksStart())
        model.send(.toggleHideDone)
        model.send(.setFlaggedOnly(true))
        let state = await waitForState(model) { $0.hideDone && $0.flaggedOnly }
        XCTAssertEqual(state?.filterActive, true)
        model.send(.clearFilters)
        let cleared = await waitForState(model) { !$0.flaggedOnly }
        XCTAssertEqual(cleared?.filterActive, false)
    }

    @MainActor
    func testOpeningDetailsDeliversEachEffectOnce() async {
        let model = isolatedFactory().makeTasks(start: TasksStart())
        model.send(.openDetails(taskId: "t2"))
        model.send(.openDetails(taskId: "t4"))
        let buffered = await effects(of: model, count: 2)
        XCTAssertEqual(buffered, [.openDetails(taskId: "t2"), .openDetails(taskId: "t4")])
        model.send(.openDetails(taskId: "t5"))
        let next = await effects(of: model, count: 1)
        XCTAssertEqual(next, [.openDetails(taskId: "t5")], "A new collector must not receive delivered effects again")
    }

    @MainActor
    func testAnObserverCancelledBeforeTakingAnEffectLeavesItToTheNextObserver() async throws {
        let model = isolatedFactory().makeTasks(start: TasksStart())
        model.send(.openDetails(taskId: "t2"))
        try await letEffectsReachTheBridge()
        let receivedByCancelled = Received<TasksEffect>()
        let ended = expectation(description: "The cancelled observer's stream ended")
        let cancelled = Task { @MainActor in
            for await effect in model.effects() { receivedByCancelled.values.append(effect) }
            ended.fulfill()
        }
        cancelled.cancel()
        await fulfillment(of: [ended], timeout: 5)
        let receivedByNext = await effects(of: model, count: 1)
        XCTAssertEqual(receivedByCancelled.values, [], "A cancelled observer must not take effects")
        XCTAssertEqual(receivedByNext, [.openDetails(taskId: "t2")])
    }

    @MainActor
    func testAnObserverThatStopsLeavesTheEffectsItDidNotTakeToTheNextObserver() async throws {
        let model = isolatedFactory().makeTasks(start: TasksStart())
        model.send(.openDetails(taskId: "t2"))
        model.send(.openDetails(taskId: "t4"))
        try await letEffectsReachTheBridge()
        let first = await effects(of: model, count: 1)
        let second = await effects(of: model, count: 1)
        XCTAssertEqual(first, [.openDetails(taskId: "t2")])
        XCTAssertEqual(second, [.openDetails(taskId: "t4")])
    }

    @MainActor
    func testObservingAgainAfterCancellationDeliversEveryEffectOnceInOrder() async throws {
        let model = isolatedFactory().makeTasks(start: TasksStart())
        let log = DeliveryLog()
        let firstEnded = expectation(description: "The first observation ended")
        let first = Task {
            await model.observe(onState: { _ in }, onEffect: { log.record($0, by: 1) })
            firstEnded.fulfill()
        }
        model.send(.openDetails(taskId: "t1"))
        try await eventually { log.deliveries.count == 1 }
        // Raised as the screen goes away (a sheet over it), then one while nobody observes; back on screen, the
        // restarted observer receives both.
        model.send(.openDetails(taskId: "t2"))
        first.cancel()
        await fulfillment(of: [firstEnded], timeout: 5)
        model.send(.openDetails(taskId: "t3"))
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
            Delivery(observer: 1, effect: .openDetails(taskId: "t1")),
            Delivery(observer: 2, effect: .openDetails(taskId: "t2")),
            Delivery(observer: 2, effect: .openDetails(taskId: "t3"))
        ])
        XCTAssertEqual(later, [], "A delivered effect must not be delivered again")
    }

    @MainActor
    func testCancellingTheObserverEndsTheStateStream() async {
        let model = isolatedFactory().makeTasks(start: TasksStart())
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
    func testReleasingTheTasksBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedTasksScreenModel? = try XCTUnwrap(
            isolatedFactory().makeTasks(start: TasksStart()) as? SharedTasksScreenModel
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

    // MARK: - Podrobnosti
    @MainActor
    func testDetailsOfAnEventFailAsUnauthorizedWithoutASessionAndRetryLoadsAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeItemDetails(kind: .event, itemId: "e1") as? SharedItemDetailsScreenModel
        )
        XCTAssertEqual(model.state.kind, .event)
        let state = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(state?.phase, .failure(.unauthorized))
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.phase, .failure(.unauthorized))
    }

    @MainActor
    func testReleasingTheDetailsBridgeClosesTheKotlinViewModelAndEndsItsEffects() async throws {
        var model: SharedItemDetailsScreenModel? = try XCTUnwrap(
            isolatedFactory().makeItemDetails(kind: .task, itemId: "t1") as? SharedItemDetailsScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        model = nil
        XCTAssertTrue(lease.isClosed)
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished)
    }
}

// MARK: - Helpers
// The helpers that iterate a stream wait with a timeout and then cancel their task, so a stream that ignores
// cancellation fails the test instead of hanging it.
private extension SharedWorkScreenModelTests {

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
    let effect: TasksEffect
}

/// The effects observers received, in the order they received them.
@MainActor
private final class DeliveryLog {

    // MARK: - Properties
    private(set) var deliveries: [Delivery] = []

    // MARK: - Methods
    func record(_ effect: TasksEffect, by observer: Int) {
        deliveries.append(Delivery(observer: observer, effect: effect))
    }
}
