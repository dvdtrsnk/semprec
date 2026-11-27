import XCTest

@testable import CoreKit

/// Drives the real Kotlin collection and item ViewModels through the native bridges. A test has no server and no
/// signed-in session, so what the ViewModels can show is their unauthorized failure and what an action does before
/// anything has loaded; the loaded states are checked with the mapping tests and the Kotlin ViewModel tests.
final class SharedCollectionScreenModelTests: XCTestCase {

    // MARK: - Properties
    private let target = CollectionTarget.whole(databaseKey: "projects", databaseId: nil)

    // MARK: - Tests
    @MainActor
    func testACollectionWithoutASessionIsUnauthorized() async {
        let model = isolatedFactory().makeCollection(target: target)
        let state = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(state, CollectionState(phase: .error, failure: .unauthorized))
        XCTAssertEqual(model.state.phase, .error)
    }

    @MainActor
    func testAnItemWithoutASessionIsUnauthorized() async {
        let model = isolatedFactory().makeItem(itemId: "i1", databaseKey: "projects")
        let state = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(state, ItemState(phase: .error, failure: .unauthorized))
    }

    // A reload ends in the same failure as the load before it; a new state value in the Kotlin ViewModel is what
    // shows that the retry reached it.
    @MainActor
    func testRetryMakesTheKotlinCollectionViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeCollection(target: target) as? SharedCollectionScreenModel
        )
        _ = await waitForState(model) { $0.phase != .loading }
        let failed = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === failed, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.failure, .unauthorized)
    }

    @MainActor
    func testRetryMakesTheKotlinItemViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeItem(itemId: "i1", databaseKey: nil) as? SharedItemScreenModel
        )
        _ = await waitForState(model) { $0.phase != .loading }
        let failed = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === failed, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.failure, .unauthorized)
    }

    @MainActor
    func testOpeningItemsDeliversEachEffectOnceInOrder() async {
        let model = isolatedFactory().makeCollection(target: target)
        model.send(.openItem(id: "p1"))
        model.send(.openItem(id: "p2"))
        let received = await effects(of: model, count: 2)
        XCTAssertEqual(
            received,
            [.openItem(itemId: "p1", databaseKey: nil), .openItem(itemId: "p2", databaseKey: nil)]
        )
    }

    @MainActor
    func testOpeningATargetOfAnItemDeliversItsEffect() async {
        let model = isolatedFactory().makeItem(itemId: "i1", databaseKey: nil)
        model.send(.navigate(.openTarget(id: "a1", databaseKey: "companies")))
        let received = await effects(of: model, count: 1)
        XCTAssertEqual(received, [.openItem(itemId: "a1", databaseKey: "companies")])
    }

    @MainActor
    func testReleasingTheBridgesClosesTheKotlinViewModels() async throws {
        var collection: SharedCollectionScreenModel? = try XCTUnwrap(
            isolatedFactory().makeCollection(target: target) as? SharedCollectionScreenModel
        )
        var item: SharedItemScreenModel? = try XCTUnwrap(
            isolatedFactory().makeItem(itemId: "i1", databaseKey: nil) as? SharedItemScreenModel
        )
        let collectionLease = try XCTUnwrap(collection?.lease)
        let itemLease = try XCTUnwrap(item?.lease)
        let collectionEffects = try XCTUnwrap(collection?.effects())
        let itemEffects = try XCTUnwrap(item?.effects())
        XCTAssertFalse(collectionLease.isClosed || itemLease.isClosed)
        collection = nil
        item = nil
        XCTAssertTrue(collectionLease.isClosed)
        XCTAssertTrue(itemLease.isClosed)
        let collectionFinished = await finishes(collectionEffects, within: 5)
        let itemFinished = await finishes(itemEffects, within: 5)
        XCTAssertTrue(collectionFinished)
        XCTAssertTrue(itemFinished)
    }
}

// MARK: - Helpers
private extension SharedCollectionScreenModelTests {

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

    /// The effects one new observer receives until it has `count` of them, or until `timeout` seconds pass.
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
