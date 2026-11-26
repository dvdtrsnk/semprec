import SharedSDK
import XCTest

@testable import CoreKit

/// The sleep bridge over the real Kotlin ViewModel: its state, its actions and its lease.
final class SharedSleepScreenModelTests: XCTestCase {

    // MARK: - The real Kotlin ViewModel
    // Without a session the repository answers "unauthorized" without a request, so the bridge shows that failure.
    @MainActor
    func testTheRealViewModelFailsAsUnauthorizedWithoutASessionAndOpensOnTheNight() async throws {
        let model = isolatedFactory().makeSleep(night: "2026-10-16", startOnNight: true)

        let state = await waitForState(model) { $0.phase != .loading }

        XCTAssertEqual(state?.phase, .failure(.unauthorized))
        XCTAssertEqual(state?.page, .night)
        XCTAssertEqual(state?.isRoot, true)
    }

    @MainActor
    func testRetryMakesTheKotlinSleepViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeSleep(night: nil, startOnNight: false) as? SharedSleepScreenModel
        )
        _ = await waitForState(model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value

        model.send(.retry)

        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.phase, .failure(.unauthorized))
    }

    // Nothing is loaded without a session, so every draft action reaches the Kotlin ViewModel and finds no data to
    // change; the state it holds stays the very same value.
    @MainActor
    func testEveryDraftActionReachesTheKotlinViewModelAndChangesNothingWithoutAnOverview() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeSleep(night: "2026-10-16", startOnNight: true) as? SharedSleepScreenModel
        )
        _ = await waitForState(model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value

        let actions: [CoreKit.SleepAction] = [
            .draft(.editPlan(planID: nil)), .draft(.editPlan(planID: "p1")), .draft(.moveDial(.bed, minutes: 60)),
            .draft(.toggleDay(3)), .draft(.setAlarm(isOn: false)), .draft(.confirm(newPlanName: "Other")),
            .draft(.deletePlan), .draft(.discard), .draft(.commitNight), .resetNight
        ]
        for action in actions {
            model.send(action)
            XCTAssertTrue(model.viewModel.state.value === loaded, "\(action) must change nothing without data")
        }
        XCTAssertNil(model.state.editor)
        XCTAssertNil(model.state.nightDraft)
    }

    @MainActor
    func testAnActionAfterReleaseReachesNothing() throws {
        var model: SharedSleepScreenModel? = try XCTUnwrap(
            isolatedFactory().makeSleep(night: nil, startOnNight: false) as? SharedSleepScreenModel
        )
        let viewModel = try XCTUnwrap(model?.viewModel)
        model = nil

        viewModel.onAction(action: SharedSleepScreenModel.action(.draft(.editPlan(planID: nil))))

        XCTAssertTrue(viewModel.isClosed)
        XCTAssertNil(viewModel.state.value.editor)
    }

    @MainActor
    func testReleasingTheBridgeClosesTheKotlinSleepViewModel() throws {
        var model: SharedSleepScreenModel? = try XCTUnwrap(
            isolatedFactory().makeSleep(night: nil, startOnNight: false) as? SharedSleepScreenModel
        )
        let viewModel = try XCTUnwrap(model?.viewModel)
        XCTAssertFalse(viewModel.isClosed)

        model = nil

        XCTAssertTrue(viewModel.isClosed)
    }

    // MARK: - Helpers
    /// The first state of `model` that matches `predicate`, or `nil` when none arrives within five seconds.
    @MainActor
    private func waitForState<Model: ScreenModel>(
        _ model: Model,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Found<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.value = state
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: 5)
        observer.cancel()
        return found.value
    }
}

// MARK: - Support
@MainActor
private final class Found<Value> {

    var value: Value?
}
