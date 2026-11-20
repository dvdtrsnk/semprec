import XCTest

@testable import CoreKit

/// Drives the real Kotlin diary ViewModels through the native bridges. The test host has no signed-in session, so
/// every read ends in an unauthorized failure without a request, which is enough to show the bridges deliver state and
/// effects and close their ViewModels.
final class SharedJournalScreenModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheDiaryOpensOnTheGivenDayAndWithoutASessionEndsUnauthorized() async {
        let model = isolatedFactory().makeJournal(initialDay: "2026-10-14")
        XCTAssertEqual(model.state.selection, JournalSelection(kind: .day, start: "2026-10-14"))
        XCTAssertEqual(model.state.axis.map(\.kind), [.year, .quarter, .month, .day])
        let failed = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        XCTAssertNotNil(failed)
    }

    @MainActor
    func testSelectingAPeriodReachesTheKotlinViewModel() async {
        let model = isolatedFactory().makeJournal(initialDay: "2026-10-14")
        model.send(.select(kind: .month, start: "2026-09-20"))
        let target = JournalSelection(kind: .month, start: "2026-09-01")
        let selected = await waitForState(model) { $0.selection == target }
        XCTAssertNotNil(selected)
    }

    @MainActor
    func testRetryMakesTheKotlinDiaryLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeJournal(initialDay: "2026-10-14") as? SharedJournalScreenModel
        )
        _ = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        let failed = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === failed, "Retry must start a new load of the Kotlin ViewModel")
        let again = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        XCTAssertNotNil(again)
    }

    @MainActor
    func testEffectsAreDeliveredOnceInOrder() async {
        let model = isolatedFactory().makeJournal(initialDay: "2026-10-14")
        model.send(.openEvent(id: "e1"))
        model.send(.openInbox)
        let received = await effects(of: model, count: 2)
        XCTAssertEqual(received, [.openEvent(id: "e1"), .openInbox])
        let again = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(again, [], "A delivered effect must not be delivered again")
    }

    @MainActor
    func testReleasingTheDiaryBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedJournalScreenModel? = try XCTUnwrap(
            isolatedFactory().makeJournal(initialDay: "2026-10-14") as? SharedJournalScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished)
    }
}

// MARK: - Helpers
private extension SharedJournalScreenModelTests {

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
